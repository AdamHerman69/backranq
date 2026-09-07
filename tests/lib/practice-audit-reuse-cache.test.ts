import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, legalMovesUci } from '@/lib/training/practiceContract';
import type { EngineIdentity } from '@/lib/analysis/stockfishClient';
import { openPaidComparatorCache, PAID_COMPARATOR_V8_BUDGETS } from '../../scripts/lib/practice-audit-reuse-cache';
import { practiceV4Fixture } from '../helpers/practice-v4';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-paid-cache-')); directories.push(directory);
    const manifest = practiceV4Fixture();
    const identity = { budgets: PAID_COMPARATOR_V8_BUDGETS, artifactVersion: 8, sessionMode: 'INDEPENDENT_ANSWERS', localEngineProtocol: 'FRESH_ENGINE_AND_SESSION_PER_ANSWER' };
    const run = { ...identity, fingerprint: hash(identity), createdAt: 'test' };
    const capture = { artifactVersion: 8, fingerprint: run.fingerprint, index: 0, sourceHash: hash(manifest.source), manifest };
    const legal = legalMovesUci(manifest.source.fen);
    const report = { ...identity, fingerprint: run.fingerprint, index: 0, captureHash: hash(capture),
        contextId: manifest.source.contextId, fen: manifest.source.fen, sourceGameId: manifest.source.gameId,
        legalMoves: legal.length, rows: legal.map(moveUci => ({ moveUci })), comparator: { budgets: PAID_COMPARATOR_V8_BUDGETS, evidence: manifest.evidence } };
    const write = (file: string, value: unknown) => fs.writeFileSync(path.join(directory, file), JSON.stringify(value));
    write('run.json', run); write('position-0.json', capture); write('comparison-0.json', report);
    return { directory, manifest, run, capture, report, write };
}
describe('immutable paid comparator cache boundary', () => {
    it('binds all completed file bytes into the new run fingerprint and returns no match for a new source', () => {
        const f = fixture(); const first = openPaidComparatorCache(f.directory);
        expect(first.completedPositions).toBe(1);
        expect(first.project({ ...f.manifest.source, contextId: 'new-source' }, {} as EngineIdentity)).toBeNull();
        f.write('comparison-0.json', { ...f.report, diagnostic: 'changed' });
        expect(openPaidComparatorCache(f.directory).fingerprint).not.toBe(first.fingerprint);
        expect(() => first.project(f.manifest.source, {} as EngineIdentity)).toThrow('changed during run');
    });
    it('rejects a changed run identity and corrupt source capture', () => {
        const f = fixture(); f.write('run.json', { ...f.run, artifactVersion: 7 });
        expect(() => openPaidComparatorCache(f.directory)).toThrow('corrupt paid comparator run');
        f.write('run.json', f.run); f.write('position-0.json', { ...f.capture, sourceHash: 'invalid' });
        expect(() => openPaidComparatorCache(f.directory)).toThrow('Invalid paid capture');
    });
    it('rejects an incomplete or duplicate legal-answer set before interpreting evidence', () => {
        const f = fixture(); f.report.rows[1] = f.report.rows[0]; f.write('comparison-0.json', f.report);
        expect(() => openPaidComparatorCache(f.directory).project(f.manifest.source, {} as EngineIdentity)).toThrow('Incomplete or mismatched');
    });
    it('refuses a relabelled cheap comparator without all-legal paid search pairs', () => {
        const f = fixture();
        expect(() => openPaidComparatorCache(f.directory).project(f.manifest.source, {} as EngineIdentity)).toThrow('all-legal physical search pair');
    });
    it('does not count stopped requested budgets as completed stronger searches', () => {
        const f = fixture(); const template = Object.values(f.manifest.evidence.searches)[0];
        for (const move of legalMovesUci(f.manifest.source.fen)) for (const nodes of [800_000, 1_600_000]) {
            const id = `${move}:${nodes}`;
            f.report.comparator.evidence.searches[id] = { ...structuredClone(template), id, reason: 'MISSING_MOVE', completion: 'STOPPED',
                request: { ...structuredClone(template.request), rootScopeUci: [move], multiPv: 1, limit: { nodes, depth: null, movetimeMs: null } } };
        }
        f.write('comparison-0.json', f.report);
        expect(() => openPaidComparatorCache(f.directory).project(f.manifest.source, {} as EngineIdentity)).toThrow('all-legal physical search pair');
    });
    it('rejects mismatched completion provenance before interpreting evidence', () => {
        const f = fixture(); f.report.captureHash = 'wrong'; f.write('comparison-0.json', f.report);
        expect(() => openPaidComparatorCache(f.directory).project(f.manifest.source, {} as EngineIdentity)).toThrow('Incomplete or mismatched');
    });
});
