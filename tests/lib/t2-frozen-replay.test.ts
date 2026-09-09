import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { validateTrainingMomentCandidates } from '@/lib/training/candidateValidation';
import type { PositionAnalysisPoolState } from '@/lib/analysis/positionAnalysisPool';
import type { StockfishEngine, AnalysisLimit, MultiPvResult } from '@/lib/analysis/stockfishClient';
import type { StudyGame, StudyDecision } from '../../scripts/extractor-study/types';
// Optional local immutable research corpus. This adapter cannot execute an engine or network request.
const base = resolve('artifacts/extractor-study/priority-v1');
const fixtures = ['19658fef86e6cec4005ff6aa', 'e33dcbfee4ad17d2579cf6bd'];
describe.skipIf(!existsSync(`${base}/results/${fixtures[0]}.json`))('frozen engine response replay through production T2', () => {
    for (const id of fixtures) it(`preserves full-game admission and homepage validity for ${id}`, async () => {
        const result = JSON.parse(readFileSync(`${base}/results/${id}.json`, 'utf8')) as { job: { gameIndex: number }; poolFile: string; strategy: { decisions: StudyDecision[] } };
        const corpus = JSON.parse(readFileSync(`${base}/corpus.json`, 'utf8')) as { games: StudyGame[] };
        const source = corpus.games[result.job.gameIndex];
        const evidence = JSON.parse(readFileSync(resolve(base, result.poolFile), 'utf8')) as PositionAnalysisPoolState;
        const makeEngine = () => {
            let offset = 0;
            const engine: StockfishEngine = {
                getIdentity: async () => evidence.searches[0].evidence.engine,
                evalPosition: async () => { throw new Error('Frozen T2 does not perform single-PV eval API calls'); },
                analyzeMultiPv: async (query: AnalysisLimit & { fen: string; multiPv?: number }): Promise<MultiPvResult> => {
                    const search = evidence.searches[offset++];
                    if (!search?.result) throw new Error('Production requested work absent from the frozen run');
                    const request = search.evidence.request;
                    const roots = query.rootMoves ?? new Chess(query.fen).moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
                    expect({ fen: query.fen, history: query.previousFens, nodes: query.nodes, multiPv: query.multiPv, roots: [...roots].sort(),
                        purpose: query.purpose?.replace(/^T2_/, 'STUDY_') }).toEqual({ fen: request.fen, history: request.previousFens, nodes: request.limits.nodes,
                        multiPv: request.multiPv, roots: [...request.rootMoves].sort(), purpose: request.purpose });
                    for (const snapshot of search.snapshots) query.onSnapshot?.(structuredClone(snapshot));
                    return structuredClone({ ...search.result, snapshots: search.snapshots });
                },
            };
            return { engine, consumed: () => offset };
        };
        const full = makeEngine();
        const output = await extractTrainingMomentsFromGames({ games: [source.game], selectedGameIds: new Set([source.game.id]),
            engine: full.engine, options: { returnAnalysis: true } });
        expect(full.consumed()).toBe(evidence.searches.length);
        expect(output.moments.map(m => m.decisionPly)).toEqual(result.strategy.decisions.filter(d => d.admitted).map(d => d.ply));
        expect(validateTrainingMomentCandidates(output.moments).ok).toBe(true);
        const estimates = output.analysis!.get(source.game.id)!.trainingExtraction.decisions.map(d => ({ ply: d.ply, admitted: d.t2Decision!.admitted, estimate: d.t2Decision!.estimate, evidenceIds: d.t2Decision!.evidenceIds }));
        expect(estimates).toEqual(result.strategy.decisions.map(d => ({ ply: d.ply, admitted: d.admitted, estimate: d.estimate, evidenceIds: d.evidenceIds })));
        const homepage = makeEngine();
        const first = await extractTrainingMomentsFromGames({ games: [source.game], selectedGameIds: new Set([source.game.id]), engine: homepage.engine, strategy: 'FIRST_PUZZLE' });
        expect(first.moments.length).toBeGreaterThan(0); expect(validateTrainingMomentCandidates(first.moments).ok).toBe(true);
        expect(first.moments.every(m => output.moments.some(full => full.decisionPly === m.decisionPly))).toBe(true);
        expect(homepage.consumed()).toBeLessThanOrEqual(full.consumed());
    }, 60_000);
});
