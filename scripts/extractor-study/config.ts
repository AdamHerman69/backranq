import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse, resolve } from 'node:path';
import type { Profile, StudyConfig } from './types';

export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
export function configHash(config: StudyConfig): string {
    return createHash('sha256').update(canonicalJson(config)).digest('hex');
}
function object(value: unknown, keys: string[], at: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: expected an object`);
    const record = value as Record<string, unknown>;
    for (const key of keys) if (!(key in record)) throw new Error(`${at}: missing ${key}`);
    for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`${at}: unknown key ${key}`);
    return record;
}
function integer(value: unknown, min: number, max: number, at: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${at}: expected integer ${min}..${max}`);
    return value as number;
}
function string(value: unknown, at: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error(`${at}: expected non-empty string up to 512 characters`);
    return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], at: string): T {
    if (!values.includes(value as T)) throw new Error(`${at}: expected ${values.join(' | ')}`);
    return value as T;
}
function array(value: unknown, min: number, max: number, at: string): unknown[] {
    if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${at}: expected array length ${min}..${max}`);
    return value;
}
export function parseConfig(input: unknown): StudyConfig {
    const c = object(input, ['version', 'seed', 'month', 'outputDirectory', 'discovery', 'profiles', 'limits', 'reference'], 'config');
    if (c.version !== 1) throw new Error('config.version: expected 1');
    const month = string(c.month, 'month');
    if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) throw new Error('month: expected YYYY-MM');
    const outputDirectory = string(c.outputDirectory, 'outputDirectory');
    if (outputDirectory.includes('\0') || resolve(outputDirectory) === resolve('.') || resolve(outputDirectory) === parse(resolve(outputDirectory)).root) throw new Error('outputDirectory must be a dedicated study directory');
    const d = object(c.discovery, ['seedAccounts', 'maxAccounts', 'maxRequests', 'requestDelayMs', 'accountsPerBucket', 'developmentAccountsPerBucket', 'gamesPerAccount', 'minPlies', 'maxPlies', 'ratingEdges'], 'discovery');
    const seedAccounts = array(d.seedAccounts, 1, 100, 'seedAccounts').map((value) => {
        const username = string(value, 'seedAccount').toLowerCase();
        if (!/^[a-z0-9_-]{2,50}$/.test(username)) throw new Error('seedAccount: invalid Chess.com username');
        return username;
    });
    if (new Set(seedAccounts).size !== seedAccounts.length) throw new Error('seedAccounts: duplicates');
    const ratingEdges = array(d.ratingEdges, 1, 10, 'ratingEdges').map((value) => integer(value, 0, 4000, 'ratingEdge'));
    if (ratingEdges.some((value, i) => i > 0 && value <= ratingEdges[i - 1])) throw new Error('ratingEdges must strictly increase; first edge is the minimum eligible account rating and final bucket is open ended');
    const accountsPerBucket = integer(d.accountsPerBucket, 2, 100, 'accountsPerBucket');
    const maxAccounts = integer(d.maxAccounts, accountsPerBucket * ratingEdges.length, 5000, 'maxAccounts');
    if (seedAccounts.length > maxAccounts) throw new Error('seedAccounts exceeds maxAccounts');
    const gamesPerAccount = integer(d.gamesPerAccount, 2, 100, 'gamesPerAccount');
    if (gamesPerAccount % 2 !== 0) throw new Error('gamesPerAccount must be even for balanced colors');
    const minPlies = integer(d.minPlies, 2, 256, 'minPlies');
    const maxPlies = integer(d.maxPlies, minPlies, 256, 'maxPlies');
    const profiles: Profile[] = array(c.profiles, 1, 32, 'profiles').map((value, i) => {
        const p = object(value, ['id', 'mode', 'scanNodes', 'rootMultiPv', 'additional', 'rounds', 'postScanGameNodes', 'postScanCandidateNodes'], `profiles[${i}]`);
        const id = string(p.id, 'profile.id');
        if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(id)) throw new Error('profile.id: expected safe identifier');
        const rounds = array(p.rounds, 0, 8, 'profile.rounds').map((n) => integer(n, 1000, 100_000_000, 'roundNodes'));
        if (rounds.some((n, j) => j > 0 && n <= rounds[j - 1])) throw new Error('profile.rounds must strictly increase');
        const additional = choice(p.additional, ['CURRENT', 'NONE', 'PAIR_ONCE', 'ADAPTIVE', 'TARGETED', 'TARGETED_V2', 'TARGETED_PRIORITY'] as const, 'additional');
        const mode = choice(p.mode, ['THOROUGH', 'STANDARD', 'SINGLE', 'POINT', 'WINDOW'] as const, 'mode');
        if ((['THOROUGH', 'STANDARD', 'SINGLE'].includes(mode)) !== (additional === 'CURRENT')) throw new Error('product modes require CURRENT; POINT/WINDOW require an experimental additional strategy');
        if ((additional === 'NONE' || additional === 'CURRENT') && rounds.length) throw new Error(`${additional} requires empty rounds`);
        if (additional === 'PAIR_ONCE' && rounds.length !== 1) throw new Error('PAIR_ONCE requires exactly one round');
        if (additional === 'ADAPTIVE' && !rounds.length) throw new Error('ADAPTIVE requires rounds');
        if (additional === 'TARGETED' && (rounds.length !== 1 || mode !== 'POINT')) throw new Error('TARGETED requires POINT mode and exactly one round');
        if (additional === 'TARGETED_V2' && (rounds.length !== 1 || mode !== 'POINT')) throw new Error('TARGETED_V2 requires POINT mode and exactly one round');
        if (additional === 'TARGETED_PRIORITY' && (rounds.length !== 1 || mode !== 'POINT')) throw new Error('TARGETED_PRIORITY requires POINT mode and exactly one round');
        return {
            id, mode, additional, rounds,
            scanNodes: integer(p.scanNodes, 1000, 10_000_000, 'scanNodes'),
            rootMultiPv: integer(p.rootMultiPv, 1, 16, 'rootMultiPv'),
            postScanGameNodes: integer(p.postScanGameNodes, 0, 1_000_000_000, 'postScanGameNodes'),
            postScanCandidateNodes: integer(p.postScanCandidateNodes, 0, 100_000_000, 'postScanCandidateNodes'),
        };
    });
    if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('profile ids must be unique');
    const l = object(c.limits, ['globalNodes', 'globalCpuSeconds', 'perJobNodes', 'perJobSeconds'], 'limits');
    const limits = {
        globalNodes: integer(l.globalNodes, 1000, Number.MAX_SAFE_INTEGER, 'globalNodes'),
        globalCpuSeconds: integer(l.globalCpuSeconds, 1, 2_592_000, 'globalCpuSeconds'),
        perJobNodes: integer(l.perJobNodes, 1000, 100_000_000_000, 'perJobNodes'),
        perJobSeconds: integer(l.perJobSeconds, 1, 86400, 'perJobSeconds'),
    };
    if (limits.perJobNodes > limits.globalNodes) throw new Error('perJobNodes exceeds globalNodes');
    const r = object(c.reference, ['enabled', 'scanNodes', 'rootNodes', 'moveNodes', 'positionsPerGame'], 'reference');
    if (typeof r.enabled !== 'boolean') throw new Error('reference.enabled must be boolean');
    if (typeof r.positionsPerGame === 'number' && r.positionsPerGame % 3 !== 0) throw new Error('reference.positionsPerGame must be divisible by 3 for stratified selection');
    return {
        version: 1, seed: string(c.seed, 'seed'), month, outputDirectory,
        discovery: {
            seedAccounts, maxAccounts,
            maxRequests: integer(d.maxRequests, 1, 20000, 'maxRequests'),
            requestDelayMs: integer(d.requestDelayMs, 100, 60000, 'requestDelayMs'),
            accountsPerBucket,
            developmentAccountsPerBucket: integer(d.developmentAccountsPerBucket, 1, accountsPerBucket - 1, 'developmentAccountsPerBucket'),
            gamesPerAccount, minPlies, maxPlies, ratingEdges,
        }, profiles, limits,
        reference: {
            enabled: r.enabled,
            scanNodes: integer(r.scanNodes, 1000, 10_000_000, 'reference.scanNodes'),
            rootNodes: integer(r.rootNodes, 1000, 100_000_000, 'reference.rootNodes'),
            moveNodes: integer(r.moveNodes, 1000, 100_000_000, 'reference.moveNodes'),
            positionsPerGame: integer(r.positionsPerGame, 1, 1000, 'reference.positionsPerGame'),
        },
    };
}
export function loadConfig(path: string): StudyConfig {
    return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}
