import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { configHash, loadConfig, parseConfig } from '../../scripts/extractor-study/config';
import { median, prepareCorpus, ratingBucket, seededOrder } from '../../scripts/extractor-study/corpus';
import type { StudyConfig } from '../../scripts/extractor-study/types';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'backranq-corpus-test-')); dirs.push(dir); return dir; }
function fixtureConfig(): StudyConfig {
    const config = loadConfig('experiments/extractor-economics/blitz.json');
    config.discovery = { ...config.discovery, seedAccounts: ['alice', 'bravo'], maxAccounts: 2, maxRequests: 4, accountsPerBucket: 2, developmentAccountsPerBucket: 1, gamesPerAccount: 2, ratingEdges: [0], minPlies: 2, maxPlies: 20 };
    return config;
}
function game(id: number, account: string, side: 'white' | 'black', first: string, second: string, rating = 1500) {
    const white = side === 'white' ? account : `opponent${id}`;
    const black = side === 'black' ? account : `opponent${id}`;
    const chess = new Chess();
    chess.header('White', white, 'Black', black, 'Result', '1-0');
    chess.move(first); chess.move(second);
    return { url: `https://www.chess.com/game/live/${id}`, pgn: chess.pgn(), end_time: Date.parse('2026-08-15T12:00:00Z') / 1000, time_class: 'blitz', time_control: '180', rated: true, rules: 'chess', white: { username: white, rating, result: 'win' }, black: { username: black, rating, result: 'resigned' } };
}
function fixtureArchive() {
    return { alice: { games: [game(1, 'alice', 'white', 'e4', 'e5'), game(2, 'alice', 'black', 'd4', 'd5')] }, bravo: { games: [game(3, 'bravo', 'white', 'c4', 'e5', 2400), game(4, 'bravo', 'black', 'Nf3', 'd5', 2400)] } };
}
function mockFetch(archives = fixtureArchive()) {
    return vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        expect(url).toMatch(/^https:\/\/api\.chess\.com\/pub\/player\/[a-z0-9_-]+\/games\/2026\/08$/);
        const username = url.split('/')[5];
        return new Response(JSON.stringify(archives[username as keyof typeof archives] ?? { games: [] }), { status: 200 });
    }) as unknown as typeof fetch;
}

describe('study configuration', () => {
    it('loads runnable matrix and hashes canonical semantic key order', () => {
        const config = loadConfig('experiments/extractor-economics/blitz.json');
        expect(config.profiles.map(p => p.id)).toEqual(['B0', 'B1', 'B2', 'E0', 'E1', 'E2', 'E3', 'E4']);
        expect(configHash(config)).toBe(configHash(Object.fromEntries(Object.entries(config).reverse()) as StudyConfig));
        expect(configHash({ ...config, seed: 'other' })).not.toBe(configHash(config));
    });
    it.each([
        (c: StudyConfig) => ({ ...c, discovery: { ...c.discovery, maxPlies: 257 } }),
        (c: StudyConfig) => ({ ...c, profiles: [{ ...c.profiles[0], rootMultiPv: 17 }] }),
        (c: StudyConfig) => ({ ...c, surprise: true }),
        (c: StudyConfig) => ({ ...c, limits: { ...c.limits, globalNodes: Infinity } }),
        (c: StudyConfig) => ({ ...c, discovery: { ...c.discovery, seedAccounts: ['alice/../../'] } }),
        (c: StudyConfig) => ({ ...c, discovery: { ...c.discovery, seedAccounts: ['Alice', 'alice'] } }),
        (c: StudyConfig) => ({ ...c, discovery: { ...c.discovery, gamesPerAccount: 3 } }),
        (c: StudyConfig) => ({ ...c, discovery: { ...c.discovery, ratingEdges: [0, 1200, 1000] } }),
        (c: StudyConfig) => ({ ...c, reference: { ...c.reference, positionsPerGame: 4 } }),
        (c: StudyConfig) => ({ ...c, profiles: [{ ...c.profiles[0], additional: 'NONE' }] }),
        (c: StudyConfig) => ({ ...c, profiles: [c.profiles[0], c.profiles[0]] }),
    ])('rejects malformed configuration before side effects', mutate => {
        expect(() => parseConfig(mutate(fixtureConfig()))).toThrow();
    });
    it('uses deterministic seeded ranking and correct open-ended buckets', () => {
        expect(seededOrder(['b', 'a', 'c'], 'seed', x => x)).toEqual(seededOrder(['c', 'b', 'a'], 'seed', x => x));
        expect([1199, 1200, 1599, 1600, 1999, 2000, 2800].map(r => ratingBucket(r, [0, 1200, 1600, 2000]))).toEqual([0, 1, 1, 2, 2, 3, 3]);
        expect(median([1000, 1200, 1400, 1600])).toBe(1300);
    });
});

describe('bounded public corpus preparation', () => {
    it('freezes reproducible color-balanced games, source perspective, and resumes without HTTP', async () => {
        const dir = await directory();
        const config = fixtureConfig();
        const fetcher = mockFetch();
        const corpus = await prepareCorpus(config, dir, { fetch: fetcher, sleep: async () => {} });
        expect(corpus.complete).toBe(true);
        expect(corpus.games).toHaveLength(4);
        expect(corpus.accounts.filter(a => a.split === 'development')).toHaveLength(1);
        for (const account of corpus.accounts) {
            const games = corpus.games.filter(g => g.account === account.username);
            expect(games.map(g => g.game.provenance?.userSide).sort()).toEqual(['black', 'white']);
            expect(games.every(g => g.game.provenance?.username === account.username)).toBe(true);
            expect(account.rating).toBe(account.username === 'alice' ? 1500 : 2400);
        }
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(await prepareCorpus(config, dir, { fetch: fetcher })).toEqual(corpus);
        expect(fetcher).toHaveBeenCalledTimes(2);
        const second = await prepareCorpus(config, await directory(), { fetch: mockFetch(), sleep: async () => {} });
        expect(second).toEqual(corpus);
        await expect(prepareCorpus({ ...config, seed: 'changed' }, dir, { fetch: fetcher })).rejects.toThrow('different configuration');
    });
    it('treats the first rating edge as a lower bound and excludes lower-rated accounts', async () => {
        const config = fixtureConfig(); config.discovery.ratingEdges = [1200];
        expect(parseConfig(config).discovery.ratingEdges).toEqual([1200]);
        expect([1100, 1200, 1599, 1600, 2000].map(r => ratingBucket(r, [1200, 1600, 2000]))).toEqual([-1, 0, 0, 1, 2]);
        const valid = await prepareCorpus(config, await directory(), { fetch: mockFetch(), sleep: async () => {} });
        expect(valid.accounts.every(a => a.rating >= 1200)).toBe(true);
        const archives = fixtureArchive();
        for (const game of archives.alice.games) {
            if (game.white.username === 'alice') game.white.rating = 1100;
            else game.black.rating = 1100;
        }
        const dir = await directory();
        await expect(prepareCorpus(config, dir, { fetch: mockFetch(archives), sleep: async () => {} })).rejects.toThrow('Corpus incomplete');
        const partial = JSON.parse(await readFile(join(dir, 'corpus-shortfall.json'), 'utf8'));
        expect(partial.exclusions.account_below_minimum_rating).toBe(1);
        expect(partial.accounts.map((a: { username: string }) => a.username)).toEqual(['bravo']);
    });
    it('detects changed frozen corpus metadata, not only PGN text', async () => {
        const dir = await directory();
        const config = fixtureConfig();
        const corpus = await prepareCorpus(config, dir, { fetch: mockFetch(), sleep: async () => {} });
        corpus.games[0].split = corpus.games[0].split === 'development' ? 'holdout' : 'development';
        await writeFile(join(dir, 'corpus.json'), JSON.stringify(corpus));
        await expect(prepareCorpus(config, dir)).rejects.toThrow('content hash mismatch');
    });
    it('rejects wrong PGN identities and incomplete balanced cohorts with a persisted explanation', async () => {
        const dir = await directory();
        const archives = fixtureArchive();
        archives.alice.games[0].pgn = archives.alice.games[0].pgn.replace('"alice"', '"different"');
        await expect(prepareCorpus(fixtureConfig(), dir, { fetch: mockFetch(archives), sleep: async () => {} })).rejects.toThrow('Corpus incomplete');
        const partial = JSON.parse(await readFile(join(dir, 'corpus-shortfall.json'), 'utf8'));
        expect(partial.exclusions.pgn_identity_mismatch).toBe(1);
        expect(partial.complete).toBe(false);
        await expect(readFile(join(dir, 'corpus.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('globally deduplicates canonical move sequences across distinct accounts and IDs', async () => {
        const dir = await directory();
        const archives = fixtureArchive();
        archives.bravo.games[0] = game(3, 'bravo', 'white', 'e4', 'e5');
        await expect(prepareCorpus(fixtureConfig(), dir, { fetch: mockFetch(archives), sleep: async () => {} })).rejects.toThrow('after leakage/dedup');
        const partial = JSON.parse(await readFile(join(dir, 'corpus-shortfall.json'), 'utf8'));
        expect(partial.exclusions.global_duplicate_game_or_replay).toBe(1);
    });
    it('excludes games against selected accounts in the opposite split', async () => {
        const dir = await directory();
        const archives = fixtureArchive();
        const paired = archives.alice.games[0];
        paired.black.username = 'bravo';
        paired.pgn = paired.pgn.replace('opponent1', 'bravo');
        await expect(prepareCorpus(fixtureConfig(), dir, { fetch: mockFetch(archives), sleep: async () => {} })).rejects.toThrow('after leakage/dedup');
        const partial = JSON.parse(await readFile(join(dir, 'corpus-shortfall.json'), 'utf8'));
        expect(partial.exclusions.cross_split_opponent).toBe(1);
        expect(partial.games.every((g: { game: { id: string } }) => g.game.id !== paired.url)).toBe(true);
    });
    it('does not count unrated, non-blitz, other-month or unfinished games', async () => {
        const dir = await directory();
        const archives = fixtureArchive();
        const extra = game(5, 'alice', 'white', 'g3', 'g6');
        archives.alice.games.push(
            { ...extra, rated: false },
            { ...extra, time_class: 'rapid' },
            { ...extra, end_time: Date.parse('2026-07-15T12:00:00Z') / 1000 },
            { ...extra, pgn: extra.pgn.replaceAll('1-0', '*') },
        );
        const corpus = await prepareCorpus(fixtureConfig(), dir, { fetch: mockFetch(archives), sleep: async () => {} });
        expect(corpus.games).toHaveLength(4);
        expect(corpus.exclusions.not_rated_standard_blitz).toBe(2);
        expect(corpus.exclusions.outside_month).toBe(1);
        expect(corpus.exclusions.unfinished_game).toBe(1);
    });
    it('retries timeouts while reading a successful response body, preserving cached archives', async () => {
        const dir = await directory(); const config = fixtureConfig(); config.discovery.maxRequests = 8;
        const delays: number[] = []; const successful = mockFetch(); let failures = 0;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
            if (failures++ < 3) {
                const response = new Response('{}');
                vi.spyOn(response, 'json').mockRejectedValue(new DOMException('body timed out', 'TimeoutError'));
                return response;
            }
            return successful(...args);
        });
        try {
            const corpus = await prepareCorpus(config, dir, { fetch: fetcher, sleep: async ms => { delays.push(ms); } });
            expect(corpus.complete).toBe(true);
            expect(fetcher).toHaveBeenCalledTimes(5);
            expect(delays.slice(1, 4)).toEqual([2000, 4000, 8000]);
            expect(JSON.parse(await readFile(join(dir, 'discovery-requests.json'), 'utf8')).requests).toBe(5);
            await prepareCorpus(config, dir, { fetch: fetcher });
            expect(fetcher).toHaveBeenCalledTimes(5);
        } finally { warn.mockRestore(); }
    });
    it('honors Retry-After and stops repeated transport failures after six requests', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const config = fixtureConfig(); config.discovery.maxRequests = 10;
            const delays: number[] = []; const successful = mockFetch();
            const limited = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '12' } })).mockImplementation(successful);
            await prepareCorpus(config, await directory(), { fetch: limited, sleep: async ms => { delays.push(ms); } });
            expect(delays[1]).toBe(12_000);
            const broken = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
            const dir = await directory();
            await expect(prepareCorpus(config, dir, { fetch: broken, sleep: async () => {} })).rejects.toThrow('Corpus discovery interrupted');
            expect(broken).toHaveBeenCalledTimes(6);
            expect(JSON.parse(await readFile(join(dir, 'discovery-requests.json'), 'utf8')).requests).toBe(6);
        } finally { warn.mockRestore(); }
    });
    it('does not retry permanent HTTP errors or cache invalid archive payloads', async () => {
        for (const response of [new Response('{}', { status: 403 }), new Response('{"wrong":[]}')]) {
            const fetcher = vi.fn().mockResolvedValue(response);
            await expect(prepareCorpus(fixtureConfig(), await directory(), { fetch: fetcher, sleep: async () => {} })).rejects.toThrow('Corpus discovery interrupted');
            expect(fetcher).toHaveBeenCalledTimes(1);
        }
    });
    it('bounds HTTP retries across resume and never runs an engine', async () => {
        const dir = await directory();
        const config = fixtureConfig(); config.discovery.maxRequests = 2;
        const fetcher = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
        await expect(prepareCorpus(config, dir, { fetch: fetcher, sleep: async () => {} })).rejects.toThrow('Corpus incomplete');
        expect(fetcher).toHaveBeenCalledTimes(2);
        await expect(prepareCorpus(config, dir, { fetch: fetcher, sleep: async () => {} })).rejects.toThrow('Corpus incomplete');
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(JSON.parse(await readFile(join(dir, 'discovery-requests.json'), 'utf8')).requests).toBe(2);
    });
});
