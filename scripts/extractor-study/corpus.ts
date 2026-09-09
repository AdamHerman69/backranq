import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import type { NormalizedGame } from '@/lib/types/game';
import { configHash, canonicalJson, parseConfig } from './config';
import type { Corpus, StudyConfig, StudyGame } from './types';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const API = 'https://api.chess.com';
type ApiPlayer = { username: string; rating: number; result: string };
type ApiGame = { url: string; pgn: string; end_time: number; time_class: string; time_control: string; rated: boolean; rules: string; white: ApiPlayer; black: ApiPlayer };
type PreparedGame = { game: NormalizedGame; rating: number; side: 'white' | 'black'; opponent: string; replayHash: string; sourceHash: string };
type Account = { username: string; rating: number; bucket: number; games: PreparedGame[] };
export type PrepareOptions = { fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void> };
export function seededOrder<T>(items: T[], seed: string, key: (item: T) => string): T[] {
    return [...items].sort((a, b) => sha(`${seed}\0${key(a)}`).localeCompare(sha(`${seed}\0${key(b)}`)) || key(a).localeCompare(key(b)));
}
export function ratingBucket(rating: number, edges: number[]): number {
    if (rating < edges[0]) return -1;
    let bucket = 0;
    for (let i = 1; i < edges.length; i++) if (rating >= edges[i]) bucket = i;
    return bucket;
}
export function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
async function atomic(path: string, value: unknown): Promise<void> {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, path);
}
async function optionalJson(path: string): Promise<unknown | undefined> {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function validPlayer(value: unknown): value is ApiPlayer {
    if (!value || typeof value !== 'object') return false;
    const p = value as ApiPlayer;
    return typeof p.username === 'string' && /^[a-z0-9_-]{2,50}$/i.test(p.username) && Number.isInteger(p.rating) && p.rating > 0 && p.rating < 5000 && typeof p.result === 'string';
}
function archiveGames(value: unknown): unknown[] {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { games?: unknown }).games)) throw new Error('Public archive response does not contain a games array');
    return (value as { games: unknown[] }).games;
}
function parseGame(value: unknown, username: string, config: StudyConfig): PreparedGame | string {
    if (!value || typeof value !== 'object') return 'malformed_game';
    const g = value as ApiGame;
    if (g.time_class !== 'blitz' || g.rated !== true || g.rules !== 'chess') return 'not_rated_standard_blitz';
    if (!validPlayer(g.white) || !validPlayer(g.black) || typeof g.pgn !== 'string' || !Number.isSafeInteger(g.end_time)) return 'malformed_game';
    const white = g.white.username.toLowerCase();
    const black = g.black.username.toLowerCase();
    if ((white === username) === (black === username)) return 'identity_mismatch';
    if (typeof g.url !== 'string' || !/^https:\/\/(www\.)?chess\.com\/game\/(live|daily)\/\d+\/?$/.test(g.url)) return 'invalid_game_url';
    const playedAt = new Date(g.end_time * 1000);
    if (!Number.isFinite(playedAt.getTime()) || playedAt.toISOString().slice(0, 7) !== config.month) return 'outside_month';
    try {
        const chess = new Chess();
        chess.loadPgn(g.pgn);
        const headers = chess.getHeaders();
        if (headers.White?.toLowerCase() !== white || headers.Black?.toLowerCase() !== black) return 'pgn_identity_mismatch';
        if (!['1-0', '0-1', '1/2-1/2'].includes(headers.Result)) return 'unfinished_game';
        const draw = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);
        if (headers.Result === '1-0' ? g.white.result !== 'win' || g.black.result === 'win' : headers.Result === '0-1' ? g.black.result !== 'win' || g.white.result === 'win' : !draw.has(g.white.result) || !draw.has(g.black.result)) return 'result_mismatch';
        const moves = chess.history({ verbose: true });
        if (moves.length < config.discovery.minPlies || moves.length > config.discovery.maxPlies) return 'ply_range';
        // Standard-start chess only. No puzzle FENs or variants hidden in PGN headers.
        if (headers.SetUp === '1' || headers.FEN || (headers.Variant && headers.Variant.toLowerCase() !== 'standard')) return 'nonstandard_start';
        const side = white === username ? 'white' : 'black';
        const rawControl = typeof g.time_control === 'string' ? g.time_control : '';
        const clock = /^(\d+)(?:\+(\d+))?$/.exec(rawControl);
        const game: NormalizedGame = {
            id: g.url.replace(/\/$/, ''), provider: 'chesscom', url: g.url, playedAt: playedAt.toISOString(),
            timeClass: 'blitz', rated: true,
            white: { name: g.white.username, rating: g.white.rating }, black: { name: g.black.username, rating: g.black.rating },
            result: headers.Result, ...(headers.Termination ? { termination: headers.Termination } : {}), pgn: g.pgn,
            provenance: { username, userSide: side, timeControl: { raw: rawControl, ...(clock ? { initialSeconds: Number(clock[1]), incrementSeconds: Number(clock[2] ?? 0) } : {}) } },
        };
        return { game, rating: g[side].rating, side, opponent: side === 'white' ? black : white,
            sourceHash: sha(g.pgn), replayHash: sha(moves.map(move => `${move.from}${move.to}${move.promotion ?? ''}`).join(' ')) };
    } catch { return 'invalid_pgn'; }
}

/** No work happens until explicitly called. All HTTP is public, serial, bounded, and cached. */
export async function prepareCorpus(input: StudyConfig, directory: string, options: PrepareOptions = {}): Promise<Corpus> {
    const config = parseConfig(input);
    const hash = configHash(config);
    await mkdir(directory, { recursive: true });
    const freezePath = join(directory, 'config.freeze.json');
    const frozen = await optionalJson(freezePath);
    if (frozen !== undefined && canonicalJson(frozen) !== canonicalJson(config)) throw new Error('Study directory belongs to a different configuration. Use a new output directory.');
    if (frozen === undefined) await atomic(freezePath, config);
    const corpusPath = join(directory, 'corpus.json');
    const existing = await optionalJson(corpusPath);
    if (existing !== undefined) {
        const expectedDigest = (await readFile(join(directory, 'corpus.sha256'), 'utf8')).trim();
        if (sha(canonicalJson(existing)) !== expectedDigest) throw new Error('Frozen corpus content hash mismatch');
        const prior = existing as Corpus;
        if (prior.configHash !== hash || prior.version !== 1 || prior.complete !== true || !Array.isArray(prior.games) || !Array.isArray(prior.accounts)) throw new Error('Existing corpus is invalid or belongs to another configuration');
        // Detect modified PGNs before returning a frozen corpus to the engine runner.
        for (const entry of prior.games) if (sha(entry.game.pgn) !== entry.sourceHash) throw new Error('Frozen corpus PGN hash mismatch');
        return prior;
    }
    const cacheDir = join(directory, 'raw-cache');
    await mkdir(cacheDir, { recursive: true });
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    let requests = 0;
    let budgetExhausted = false;
    const exclusions: Record<string, number> = {};
    const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
    const ledgerPath = join(directory, 'discovery-requests.json');
    const ledger = (await optionalJson(ledgerPath)) as { configHash: string; requests: number } | undefined;
    if (ledger && (ledger.configHash !== hash || !Number.isSafeInteger(ledger.requests) || ledger.requests < 0)) throw new Error('Invalid discovery request ledger');
    requests = ledger?.requests ?? 0;
    async function fetchArchive(username: string): Promise<unknown[]> {
        const [year, month] = config.month.split('-');
        const url = `${API}/pub/player/${encodeURIComponent(username)}/games/${year}/${month}`;
        const path = join(cacheDir, `${username}-${config.month}.json`);
        const cached = await optionalJson(path) as { url: string; body: unknown; bodyHash: string } | undefined;
        if (cached) {
            if (cached.url !== url || cached.bodyHash !== sha(canonicalJson(cached.body))) throw new Error(`Invalid cached archive: ${username}`);
            return archiveGames(cached.body);
        }
        const maxAttempts = 6;
        let delayMs = config.discovery.requestDelayMs;
        const retry = (attempt: number, error: unknown, retryAfter?: string | null) => {
            if (attempt + 1 >= maxAttempts) throw error;
            const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
            const providerDelay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
                : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : 0;
            if (providerDelay > 300_000) throw new Error(`Provider requested a pause longer than five minutes for ${username}; resume later.`);
            delayMs = Math.max(config.discovery.requestDelayMs, Math.min(30_000, 2000 * 2 ** attempt), providerDelay || 0);
            console.warn(`Archive ${username}: ${String(error)}; retry ${attempt + 2}/${maxAttempts} after ${delayMs}ms.`);
        };
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (requests >= config.discovery.maxRequests) { budgetExhausted = true; throw new Error('discovery_request_budget'); }
            // Reserve before HTTP so interruption/retry cannot erase the cost limit.
            requests++;
            await atomic(ledgerPath, { configHash: hash, requests });
            await sleep(delayMs);
            let response: Response;
            let body: unknown;
            try {
                response = await fetchImpl(url, { headers: { 'User-Agent': 'Backranq-Extractor-Study/1.0 (public research corpus)', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
                // Fetch resolves at headers. Body download can still time out or disconnect.
                // Keep it inside the same retry boundary and cache only complete validated JSON.
                if (response.ok) body = await response.json();
                else await response.body?.cancel();
            } catch (error) { retry(attempt, error); continue; }
            if (response.status === 404 || response.status === 410) {
                const body = { games: [] };
                await atomic(path, { url, fetchedAt: new Date().toISOString(), status: response.status, body, bodyHash: sha(canonicalJson(body)) });
                return [];
            }
            if (!response.ok) {
                const error = new Error(`Public archive request failed for ${username}: HTTP ${response.status}`);
                if (response.status === 408 || response.status === 429 || response.status >= 500) {
                    retry(attempt, error, response.headers.get('Retry-After')); continue;
                }
                throw error;
            }
            const games = archiveGames(body);
            await atomic(path, { url, fetchedAt: new Date().toISOString(), status: response.status, body, bodyHash: sha(canonicalJson(body)) });
            return games;
        }
        throw new Error(`Public archive retries exhausted for ${username}`);
    }
    const seen = new Set<string>();
    const queued = new Set(config.discovery.seedAccounts);
    const queue = seededOrder([...queued], `${config.seed}:seeds`, x => x);
    const candidates: Account[] = [];
    while (queue.length && seen.size < config.discovery.maxAccounts && !budgetExhausted) {
        const username = queue.shift()!;
        seen.add(username);
        let archive: unknown[];
        try { archive = await fetchArchive(username); }
        catch (error) {
            if (budgetExhausted) break;
            // Do not silently turn provider/network failures into a biased smaller sample.
            throw new Error(`Corpus discovery interrupted at ${username}; rerun to reuse cached responses. ${String(error)}`);
        }
        const parsed: PreparedGame[] = [];
        const opponents = new Set<string>();
        for (const value of archive) {
            const game = parseGame(value, username, config);
            if (typeof game === 'string') { exclude(game); continue; }
            parsed.push(game);
            opponents.add(game.opponent);
        }
        for (const opponent of seededOrder([...opponents], `${config.seed}:neighbors:${username}`, x => x)) if (!queued.has(opponent)) { queue.push(opponent); queued.add(opponent); }
        // A duplicate API row may not count twice toward eligibility or rating.
        const distinct = [...new Map(parsed.map(g => [g.game.id, g])).values()];
        const half = config.discovery.gamesPerAccount / 2;
        if (distinct.filter(g => g.side === 'white').length < half || distinct.filter(g => g.side === 'black').length < half) { exclude('account_insufficient_color_games'); continue; }
        const rating = median(distinct.map(g => g.rating));
        const bucket = ratingBucket(rating, config.discovery.ratingEdges);
        if (bucket < 0) { exclude('account_below_minimum_rating'); continue; }
        candidates.push({ username, rating, bucket, games: distinct });
    }
    const ordered = config.discovery.ratingEdges.map((_, bucket) => seededOrder(candidates.filter(a => a.bucket === bucket), `${config.seed}:bucket:${bucket}`, a => a.username));
    const selected = ordered.flatMap(accounts => accounts.slice(0, config.discovery.accountsPerBucket));
    const accounts: Corpus['accounts'] = [];
    for (let bucket = 0; bucket < ordered.length; bucket++) {
        ordered[bucket].slice(0, config.discovery.accountsPerBucket).forEach((account, index) => accounts.push({ username: account.username, rating: account.rating, bucket, split: index < config.discovery.developmentAccountsPerBucket ? 'development' : 'holdout' }));
    }
    const splitByAccount = new Map(accounts.map(a => [a.username, a.split]));
    const usedIds = new Set<string>();
    const usedReplays = new Set<string>();
    const games: StudyGame[] = [];
    const shortfalls: string[] = [];
    for (let bucket = 0; bucket < ordered.length; bucket++) if (ordered[bucket].length < config.discovery.accountsPerBucket) shortfalls.push(`Bucket ${config.discovery.ratingEdges[bucket]}..${config.discovery.ratingEdges[bucket + 1] ?? 'infinity'}: only ${ordered[bucket].length}/${config.discovery.accountsPerBucket} eligible accounts`);
    for (const account of selected) {
        const split = splitByAccount.get(account.username)!;
        for (const side of ['white', 'black'] as const) {
            let count = 0;
            for (const item of seededOrder(account.games.filter(g => g.side === side), `${config.seed}:games:${account.username}:${side}`, g => g.game.id)) {
                if (splitByAccount.has(item.opponent) && splitByAccount.get(item.opponent) !== split) { exclude('cross_split_opponent'); continue; }
                if (usedIds.has(item.game.id) || usedReplays.has(item.replayHash)) { exclude('global_duplicate_game_or_replay'); continue; }
                usedIds.add(item.game.id); usedReplays.add(item.replayHash);
                games.push({ game: item.game, account: account.username, rating: item.rating, bucket: account.bucket, split, sourceHash: item.sourceHash });
                count++;
                if (count === config.discovery.gamesPerAccount / 2) break;
            }
            if (count < config.discovery.gamesPerAccount / 2) shortfalls.push(`${account.username} ${side}: ${count}/${config.discovery.gamesPerAccount / 2} distinct games after leakage/dedup filtering`);
        }
    }
    const corpus: Corpus = {
        version: 1, configHash: hash,
        samplingDescription: 'Seeded deterministic sample of a bounded public Chess.com opponent network, not a uniform sample of all Chess.com accounts. Rated completed standard-start blitz games in one UTC month. Account buckets use median eligible archive-game rating; colors balanced per account; account-level development/holdout split; global id and canonical move-sequence dedup; games against selected opposite-split accounts excluded. No engine results influence selection.',
        games, accounts, exclusions, complete: shortfalls.length === 0,
    };
    await atomic(join(directory, 'discovery-summary.json'), { configHash: hash, discoveredAccounts: seen.size, queuedAccounts: queued.size, requests, budgetExhausted, eligibleAccountsByBucket: ordered.map(group => group.length), shortfalls });
    if (shortfalls.length) {
        await atomic(join(directory, 'corpus-shortfall.json'), corpus);
        throw new Error(`Corpus incomplete; no benchmark may run. ${shortfalls.join('; ')}. Inspect corpus-shortfall.json and discovery-summary.json. Add seed accounts spanning missing ratings or raise discovery limits in a NEW output directory; existing frozen configuration is immutable.`);
    }
    // The checksum is committed first; interruption before corpus.json is safely resumable.
    const digestPath = join(directory, 'corpus.sha256');
    const tempDigest = `${digestPath}.${randomUUID()}.tmp`;
    await writeFile(tempDigest, `${sha(canonicalJson(corpus))}\n`, { flag: 'wx' });
    await rename(tempDigest, digestPath);
    await atomic(corpusPath, corpus);
    return corpus;
}
