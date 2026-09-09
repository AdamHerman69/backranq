import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectedAuditJobs } from '../../scripts/extractor-study/selectedAudit';
import { answerJobs, parseArgs, reconcileAttempts, validateCommandConfig } from '../../scripts/extractor-study/cli';
import { createMeteredEngine, emptyMeter } from '../../scripts/extractor-study/meter';
import { isPopulationReference, makeJob, productJobs, spent } from '../../scripts/extractor-study/jobs';
import { atomicJson, readJson, withLock } from '../../scripts/extractor-study/io';
import { loadConfig } from '../../scripts/extractor-study/config';
import { summarize } from '../../scripts/extractor-study/report';
import type { Attempt, JobResult } from '../../scripts/extractor-study/records';
import type { AuditSample, Corpus, StudyDecision } from '../../scripts/extractor-study/types';
import type { StockfishEngine, EvalResult } from '@/lib/analysis/stockfishClient';

const owned: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-study-fixture-')); owned.push(dir); return dir; };
afterEach(() => { for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const config = () => loadConfig('experiments/extractor-economics/blitz.json');
function attempt(): Attempt {
    return { fingerprint: 'fixture', job: makeJob('PRODUCT', 0, 'E0'), attempt: 1, state: 'RUNNING',
        startedAt: '2026-09-08', meter: emptyMeter(), nodeAllowance: 100, cpuAllowance: 100 };
}
function corpus(): Corpus {
    return { version: 1, configHash: 'fixture', samplingDescription: 'fixture', accounts: [], exclusions: {}, complete: true,
        games: ['development', 'holdout'].map((split, i) => ({ account: `player${i}`, rating: 1400, bucket: 1,
            split: split as 'development' | 'holdout', sourceHash: `hash${i}`,
            game: { id: `game${i}`, provider: 'chesscom', playedAt: '2026-08-01', timeClass: 'blitz',
                white: { name: `player${i}` }, black: { name: 'opponent' }, pgn: '1. e4 e5 1-0' } })) };
}

describe('explicit changed-position reference audit', () => {
    const source = () => {
        const c = corpus(); c.games[0].game.provenance = { username: 'player0', userSide: 'white' }; return c;
    };
    const plan = () => ({ version: 1, selections: [{ gameIndex: 0, sourceHash: 'hash0', plies: [0] }] });
    it('binds the explicit audit to source identities and prevents holdout or duplicate work', () => {
        expect(selectedAuditJobs(plan(), source())[0]).toMatchObject({ kind: 'REFERENCE', profileId: 'SELECTED_AUDIT', gameIndex: 0, auditPlies: [0] });
        for (const selection of [
            { gameIndex: 0, sourceHash: 'wrong', plies: [0] },
            { gameIndex: 1, sourceHash: 'hash1', plies: [0] },
            { gameIndex: 0, sourceHash: 'hash0', plies: [1] },
            { gameIndex: 0, sourceHash: 'hash0', plies: [0, 0] },
        ]) expect(() => selectedAuditJobs({ version: 1, selections: [selection] }, source())).toThrow();
        expect(() => selectedAuditJobs({ version: 1, selections: [plan().selections[0], plan().selections[0]] }, source())).toThrow('Duplicate');
    });
    it('requires explicit command, reference enablement, and development selection', () => {
        expect(() => validateCommandConfig(parseArgs(['audit-selected']), config())).toThrow();
        expect(() => validateCommandConfig(parseArgs(['audit-selected', '--audit-plan', 'plan.json']), config())).not.toThrow();
        expect(() => validateCommandConfig(parseArgs(['audit-selected', '--audit-plan', 'plan.json', '--split', 'holdout']), config())).toThrow();
        expect(() => validateCommandConfig(parseArgs(['run', '--audit-plan', 'plan.json']), config())).toThrow();
    });
});

describe('study command safety and resume', () => {
    it('has help as its default and rejects ambiguous flags', () => {
        expect(parseArgs([]).command).toBe('help');
        expect(() => parseArgs(['run', '--split', 'everything'])).toThrow();
        expect(() => parseArgs(['run', '--config'])).toThrow();
        expect(() => parseArgs(['run', '--max-jobs', '0'])).toThrow();
        expect(() => parseArgs(['run', '--surprise'])).toThrow();
        expect(() => parseArgs(['all', '--max-jobs', '2'])).toThrow(/separately/);
    });
    it('rejects automatic answer prerequisites before any expensive work', () => {
        const c = config(); c.reference.enabled = false;
        expect(() => validateCommandConfig(parseArgs(['all']), c)).toThrow(/require reference/);
        c.reference.enabled = true; c.profiles = c.profiles.filter(p => p.id !== 'E0');
        expect(() => validateCommandConfig(parseArgs(['all']), c)).toThrow(/configured IDs/);
    });
    it('requires a frozen selection to construct holdout work', () => {
        expect(() => productJobs(config(), corpus(), 'holdout')).toThrow(/Freeze/);
        const jobs = productJobs(config(), corpus(), 'holdout', 'E0');
        expect(jobs.every(j => j.gameIndex === 1)).toBe(true);
        expect(jobs.filter(j => j.kind === 'PRODUCT').map(j => j.profileId).sort()).toEqual(['B0', 'B2', 'E0']);
        expect(jobs.at(-1)?.kind).toBe('REFERENCE');
    });
    it('uses stable identities and accumulates retries rather than only latest results', () => {
        expect(makeJob('PRODUCT', 0, 'E0')).toEqual(makeJob('PRODUCT', 0, 'E0'));
        const a = attempt(); a.meter.requestedNodes = 90; a.meter.cpuSeconds = 2;
        expect(spent([a, { ...a, attempt: 2 }])).toEqual({ nodes: 180, cpu: 4 });
    });
    it('refuses a live owned worker instead of duplicating interrupted work', () => {
        const dir = temp(); const a = { ...attempt(), workerPid: process.pid, host: os.hostname() };
        atomicJson(path.join(dir, 'attempts', 'one.json'), a);
        expect(() => reconcileAttempts(dir, 'fixture')).toThrow(/still alive/);
    });
    it('conservatively reconciles an unowned interrupted reservation', () => {
        const dir = temp(); const a = attempt(); a.meter.requestedNodes = 50;
        atomicJson(path.join(dir, 'attempts', 'one.json'), a);
        reconcileAttempts(dir, 'fixture');
        const fixed = readJson<Attempt>(path.join(dir, 'attempts', 'one.json'));
        expect(fixed.state).toBe('FAILED'); expect(fixed.meter.cpuSeconds).toBe(100);
        expect(fixed.meter.requestedNodes).toBe(50);
    });
    it('locks the output directory exclusively and releases its own token', () => {
        const dir = temp(); const release = withLock(dir);
        expect(() => withLock(dir)).toThrow(/already running/);
        release(); const next = withLock(dir); next();
    });
});

describe('study cost accounting without any engine', () => {
    const mock = (): StockfishEngine => ({ evalPosition: vi.fn(), analyzeMultiPv: vi.fn(), cancelAll: vi.fn() });
    it('writes a reservation before a failed engine call and retains its cost', async () => {
        const dir = temp(); const file = path.join(dir, 'journal.json'); const a = attempt(); const engine = mock();
        vi.mocked(engine.evalPosition).mockImplementation(async () => {
            expect(readJson<Attempt>(file).meter.requestedNodes).toBe(80);
            throw new Error('simulated failure');
        });
        const meter = createMeteredEngine(engine, file, a);
        await expect(meter.engine.evalPosition({ fen: 'fixture', nodes: 80 })).rejects.toThrow('simulated');
        meter.finish('FAILED'); expect(a.meter.requestedNodes).toBe(80);
    });
    it('does not dispatch a query over the remaining reservation', async () => {
        const engine = mock(); const a = attempt(); const meter = createMeteredEngine(engine, path.join(temp(), 'j.json'), a);
        await expect(meter.engine.evalPosition({ fen: 'fixture', nodes: 101 })).rejects.toThrow('NODE_LIMIT');
        expect(engine.evalPosition).not.toHaveBeenCalled(); meter.finish('COMPLETED'); expect(a.state).toBe('CENSORED');
    });
    it('includes engine-child CPU and catches a limit crossed on final refresh', () => {
        const a = attempt(); let childCpu = 1;
        const meter = createMeteredEngine(mock(), path.join(temp(), 'j.json'), a, { cpuSeconds: () => childCpu, maxRssBytes: () => 1000 });
        childCpu = 101; meter.finish('COMPLETED');
        expect(a.state).toBe('CENSORED'); expect(a.meter.cpuSeconds).toBeGreaterThanOrEqual(101);
    });
    it('refunds cache hits without charging another physical search', async () => {
        const engine = mock(); const a = attempt();
        vi.mocked(engine.evalPosition).mockResolvedValue({ searchEvidence: { reused: true } } as EvalResult);
        const meter = createMeteredEngine(engine, path.join(temp(), 'j.json'), a);
        await meter.engine.evalPosition({ fen: 'fixture', nodes: 80 }); meter.finish('COMPLETED');
        expect(a.meter.requestedNodes).toBe(0); expect(a.meter.physicalSearches).toBe(0);
    });
    it('preload reports child CPU over IPC without loading Stockfish', async () => {
        const messages: Array<{ type: string; cpuSeconds?: number }> = [];
        await new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['--import', path.resolve('scripts/extractor-study/cpu-hook.mjs'),
                '-e', 'process.send({type:"fixture"}); process.disconnect();'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            child.on('message', message => messages.push(message as typeof messages[number]));
            child.once('error', reject); child.once('exit', () => resolve());
        });
        expect(messages.some(m => m.type === 'study-cpu' && typeof m.cpuSeconds === 'number' && m.cpuSeconds > 0)).toBe(true);
        expect(messages.some(m => m.type === 'fixture')).toBe(true);
    });
});

describe('study report denominators', () => {
    it('keeps failed costs, empty denominators and rating buckets explicit', () => {
        const a = attempt(); a.state = 'FAILED'; a.meter.cpuSeconds = 3;
        const r: JobResult = { fingerprint: 'fixture', job: a.job, state: 'COMPLETED', meter: emptyMeter(),
            strategy: { decisions: [], productMoments: [], errors: [] } };
        const report = summarize(config(), corpus(), [r], [a]);
        expect(report.rows[0].productAttemptCpuSeconds).toBe(3);
        expect(report.rows[0].cpuPerAdmittedIncludingRetries).toBeNull();
        expect(report.rows[0].weightedFalseAdmissionAmongResolved).toBeNull();
        expect(report.buckets.find(b => b.bucket === 1)?.cpuSecondsIncludingRetries).toBe(3);
    });
});


describe('selected audit isolation', () => {
    const decision = (ply = 0): StudyDecision => ({
        ply, originalMoveUci: ply === 0 ? 'e2e4' : 'g1f3', preferredMoveUci: 'd2d4',
        candidate: true, admitted: true, reason: 'fixture', estimate: 'BELOW_STANDARD',
        lossCp: 200, lossExpectedScore: 0.2, referenceScore: null, originalScore: null,
        comparisonBasis: 'SAME_ROOT', evidenceIds: [],
    });
    const sample = (ply: number, estimate: StudyDecision['estimate']): AuditSample => ({
        ply, stratum: 'ADMITTED', population: 2, inclusionProbability: 0.5,
        decision: { ...decision(ply), estimate }, strictQuality: 'UNKNOWN', alternatives: [],
    });
    function fixtures() {
        const source = corpus();
        source.games[0].game.pgn = '1. e4 e5 2. Nf3 Nc6 1-0';
        const product: JobResult = { fingerprint: 'fixture', job: makeJob('PRODUCT', 0, 'E0'), state: 'COMPLETED', meter: emptyMeter(),
            strategy: { decisions: [decision(0)], productMoments: [], errors: [] } };
        const reference: JobResult = { fingerprint: 'fixture', job: makeJob('REFERENCE', 0, 'REFERENCE'), state: 'COMPLETED', meter: emptyMeter(),
            reference: { samples: [sample(0, 'GOOD')], scanCandidates: [], errors: [] } };
        const selected: JobResult = { fingerprint: 'fixture', job: { ...makeJob('REFERENCE', 0, 'SELECTED_AUDIT'), auditPlies: [0, 2] }, state: 'COMPLETED', meter: emptyMeter(),
            reference: { samples: [sample(0, 'BELOW_STANDARD'), sample(2, 'BELOW_STANDARD')].map(s => ({ ...s, inclusionProbability: 1 })), scanCandidates: [], errors: [] } };
        return { source, product, reference, selected };
    }
    it('recognizes only ordinary population reference jobs', () => {
        expect(isPopulationReference(makeJob('REFERENCE', 0, 'REFERENCE'))).toBe(true);
        expect(isPopulationReference(makeJob('REFERENCE', 0, 'SELECTED_AUDIT'))).toBe(false);
        expect(isPopulationReference({ ...makeJob('REFERENCE', 0, 'REFERENCE'), auditPlies: [] })).toBe(false);
        expect(isPopulationReference(makeJob('PRODUCT', 0, 'REFERENCE'))).toBe(false);
    });
    it('keeps population estimates unchanged even when selected results come first', () => {
        const { source, product, reference, selected } = fixtures();
        const baseline = summarize(config(), source, [product, reference], []);
        const selectedAttempt: Attempt = { ...attempt(), job: selected.job, state: 'COMPLETED', meter: { ...emptyMeter(), requestedNodes: 500, cpuSeconds: 2 } };
        const combined = summarize(config(), source, [selected, product, reference], [selectedAttempt]);
        expect(baseline.rows[0].weightedFalseAdmissionAmongResolved).toBe(1);
        expect(combined.rows).toEqual(baseline.rows);
        expect(combined.accounts).toEqual(baseline.accounts);
        expect(combined.buckets).toEqual(baseline.buckets);
        expect(combined.selectedAudit).toEqual({ populationEstimate: false, resultFiles: 1, completedJobs: 1,
            completedPositions: 2, attemptNodes: 500, attemptCpuSeconds: 2 });
        expect(combined.totalExperiment).toEqual({ nodes: 500, cpu: 2 });
        const onlySelected = summarize(config(), source, [selected, product], []);
        expect(onlySelected.rows[0].sampledAdmitted).toBe(0);
        expect(onlySelected.rows[0].weightedFalseAdmissionAmongResolved).toBeNull();
    });
    it('keeps ordinary answer workload unchanged and rejects selected-only evidence', () => {
        const { source, product, reference, selected } = fixtures();
        const directory = temp();
        const save = (result: JobResult) => atomicJson(path.join(directory, 'results', result.job.id + '.json'), result);
        save(product); save(reference);
        const baseline = answerJobs(config(), source, directory, 'development', ['E0']);
        expect(baseline.length).toBeGreaterThan(0);
        save(selected);
        expect(answerJobs(config(), source, directory, 'development', ['E0'])).toEqual(baseline);
        fs.unlinkSync(path.join(directory, 'results', reference.job.id + '.json'));
        expect(() => answerJobs(config(), source, directory, 'development', ['E0'])).toThrow('No audited admitted positions');
    });
});
