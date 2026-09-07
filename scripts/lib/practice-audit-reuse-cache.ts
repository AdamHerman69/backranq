import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, legalMovesUci, type SourceDecision, type SearchRecord } from '@/lib/training/practiceContract';
import { practiceEngineFingerprint } from '@/lib/analysis/practiceEvidence';
import type { EngineIdentity } from '@/lib/analysis/stockfishClient';
import { projectPaidComparator } from './practice-audit-reuse';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const hash = (value: unknown) => sha(canonicalJson(value));
export const PAID_COMPARATOR_V8_BUDGETS = { capture: [200_000, 400_000, 800_000], comparatorReference: [1_600_000, 3_200_000, 6_400_000], comparatorProbe: [1_600_000, 3_200_000, 6_400_000], comparatorMove: [800_000, 1_600_000], captureMaximumNodes: 2_800_000, comparatorReferenceMaximumNodes: 22_400_000, captureSearchTimeoutMs: 30_000, comparatorSearchTimeoutMs: 120_000, localNodes: 1_500_000, localWallMs: 8_000 };
type BaseCapture = { artifactVersion: number; fingerprint: string; index: number; sourceHash: string; manifest: { source: SourceDecision } | null };
type BaseReport = { artifactVersion: number; fingerprint: string; index: number; captureHash: string;
    contextId: string; fen: string; sourceGameId: string; sessionMode: string; localEngineProtocol: string;
    legalMoves: number; rows: { moveUci: string }[]; comparator: { evidence: unknown; cost: unknown; work: unknown; budgets: unknown } };
/** Immutable audit inputs only. A bad cache aborts instead of silently dropping evidence. */
export function openPaidComparatorCache(directory: string) {
    const runBytes = fs.readFileSync(path.join(directory, 'run.json'));
    const run = JSON.parse(runBytes.toString()) as { artifactVersion: number; fingerprint: string; sessionMode: string; localEngineProtocol: string; budgets: unknown };
    const identity = JSON.parse(runBytes.toString());
    const fingerprint = identity.fingerprint; delete identity.fingerprint; delete identity.createdAt;
    if (run.artifactVersion !== 8 || hash(identity) !== fingerprint || run.sessionMode !== 'INDEPENDENT_ANSWERS'
        || run.localEngineProtocol !== 'FRESH_ENGINE_AND_SESSION_PER_ANSWER' || canonicalJson(run.budgets) !== canonicalJson(PAID_COMPARATOR_V8_BUDGETS)) throw new Error('Unsupported or corrupt paid comparator run');
    const entries = new Map<string, { source: SourceDecision; capture: BaseCapture; captureSha256: string; reportSha256: string; reportFile: string }>();
    const files: [string, string][] = [['run.json', sha(runBytes)]];
    for (const file of fs.readdirSync(directory).filter(file => /^comparison-\d+\.json$/.test(file)).sort()) {
        const index = Number(file.match(/\d+/)![0]);
        const captureFile = `position-${index}.json`;
        const bytes = fs.readFileSync(path.join(directory, captureFile));
        const capture = JSON.parse(bytes.toString()) as BaseCapture;
        if (capture.artifactVersion !== 8 || capture.fingerprint !== run.fingerprint || capture.index !== index
            || !capture.manifest || hash(capture.manifest.source) !== capture.sourceHash) throw new Error(`Invalid paid capture ${index}`);
        const source = capture.manifest.source;
        if (entries.has(source.contextId)) throw new Error('Duplicate paid comparator source');
        const reportSha256 = sha(fs.readFileSync(path.join(directory, file)));
        entries.set(source.contextId, { source, capture, captureSha256: sha(bytes), reportSha256, reportFile: file });
        files.push([captureFile, sha(bytes)], [file, reportSha256]);
    }
    if (!entries.size) throw new Error('No completed paid comparisons');
    return {
        fingerprint: hash(files), baseRunFingerprint: run.fingerprint, completedPositions: entries.size,
        project(source: SourceDecision, engine: EngineIdentity) {
            const entry = entries.get(source.contextId); if (!entry) return null;
            const bytes = fs.readFileSync(path.join(directory, entry.reportFile));
            if (sha(bytes) !== entry.reportSha256) throw new Error('Paid comparator changed during run');
            const report = JSON.parse(bytes.toString()) as BaseReport;
            const legal = legalMovesUci(source.fen);
            if (report.artifactVersion !== 8 || report.fingerprint !== run.fingerprint || report.index !== entry.capture.index
                || report.captureHash !== hash(entry.capture) || report.sessionMode !== run.sessionMode || report.localEngineProtocol !== run.localEngineProtocol
                || report.contextId !== source.contextId || report.fen !== source.fen || report.sourceGameId !== source.gameId
                || report.legalMoves !== legal.length || !Array.isArray(report.rows)
                || canonicalJson(report.rows.map(row => row.moveUci).sort()) !== canonicalJson(legal)) throw new Error('Incomplete or mismatched paid comparison');
            if (canonicalJson(report.comparator.budgets) !== canonicalJson(PAID_COMPARATOR_V8_BUDGETS)) throw new Error('Paid comparator budgets differ');
            const physical = Object.values((report.comparator.evidence as { searches: Record<string, SearchRecord> }).searches);
            for (const move of legal) for (const nodes of PAID_COMPARATOR_V8_BUDGETS.comparatorMove) {
                if (!physical.some(search => search.reason === 'MISSING_MOVE' && search.completion === 'COMPLETED' && search.request.multiPv === 1 && search.request.limit.nodes === nodes
                    && search.request.rootScopeUci.length === 1 && search.request.rootScopeUci[0] === move)) throw new Error('Paid comparator lacks its all-legal physical search pair');
            }
            const expectedEngineIdentity: SearchRecord['engineIdentity'] = {
                fingerprint: practiceEngineFingerprint(engine), artifactId: engine.artifactId, name: engine.name,
                build: engine.version ?? engine.flavor ?? 'unknown', nnue: engine.evalFile ?? 'bundled', options: { ...engine.options },
                wdlModel: engine.options.UCI_ShowWDL === false ? null : engine.version ?? engine.name, source: 'SERVER_ENGINE',
            };
            const rawEvidenceJson = JSON.stringify(report.comparator.evidence);
            const projection = projectPaidComparator({ rawEvidenceJson, baseEvidenceSha256: sha(rawEvidenceJson),
                baseRunFingerprint: run.fingerprint, baseSource: entry.source, source, expectedEngineIdentity });
            return { ...projection, base: { reportFile: entry.reportFile, reportSha256: entry.reportSha256,
                captureSha256: entry.captureSha256, cost: report.comparator.cost, work: report.comparator.work, budgets: report.comparator.budgets } };
        },
    };
}
export type PaidComparatorCache = ReturnType<typeof openPaidComparatorCache>;
