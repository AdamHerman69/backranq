import type { StockfishEngine } from './stockfishClient';
import { PositionAnalysisPool } from './positionAnalysisPool';
import { assessPracticePosition } from './practiceMomentBuilder';
import type { AssessmentPolicy, Side } from '@/lib/training/practiceContract';

/** One bounded search of missing answers, preserving the already-paid reference. */
export async function supplementPracticeCoverage(args: {
    pool: PositionAnalysisPool; engine: StockfishEngine; fen: string; positionHistory: string[];
    trainingSide: Side; originalMoveUci: string; minimumConfirmationNodes: number;
    policy: AssessmentPolicy; signal?: AbortSignal; timeoutMs: number;
}): Promise<void> {
    const searches = args.pool.find({ fen: args.fen, previousFens: args.positionHistory });
    if (searches.some(s => s.evidence.request.purpose === 'OPTIONAL_COVERAGE')) return;
    const root = assessPracticePosition(args);
    if (!root || root.decision.selection !== 'INCLUDED') return;
    const unresolved = root.rootAnswerIndex.unresolvedMovesUci;
    if (!unresolved.length) return;
    const latestRoot = searches.findLast(s => s.result && s.evidence.request.rootMoves.length === root.rootAnswerIndex.legalMovesUci.length);
    const tail = latestRoot?.result?.lines.slice(-2).map(line => root.assessments.find(a => a.moveUci === line.pvUci[0])) ?? [];
    const stableBoundary = tail.length === 2 && tail.every(a => a?.qualitySupport === 'SUPPORTED')
        && tail.at(-1)?.quality === 'BELOW_STANDARD';
    if (unresolved.length > 3 && !stableBoundary) return;
    const confirmationNodes = searches.filter(s => ['MISSING_REFERENCE', 'MISSING_MOVE', 'UNSTABLE_QUALITY', 'REFERENCE_DRIFT'].includes(s.evidence.request.purpose))
        .reduce((sum, s) => sum + s.evidence.reported.nodes, 0);
    const nodes = Math.min(100_000, Math.floor(confirmationNodes * 0.2));
    if (nodes < 1) return;
    const reference = root.assessments.find(assessment => assessment.id === root.frame.referenceAssessmentId);
    // A smaller CP/WDL search cannot supply the latest mature point required
    // for an answer. Preserve the allowance instead of doing futile coverage.
    // Stable symbolic mates can complete with very little physical work.
    if (reference?.score?.kind !== 'MATE' && nodes < args.policy.latestSupportNodes) return;
    try {
        await args.engine.analyzeMultiPv({ fen: args.fen, previousFens: args.positionHistory,
            rootMoves: unresolved, multiPv: Math.min(3, unresolved.length), nodes,
            timeoutMs: Math.min(args.timeoutMs, 2_000), signal: args.signal,
            reuse: 'FRESH_REQUIRED', purpose: 'OPTIONAL_COVERAGE' });
    } catch (error) {
        if (args.signal?.aborted) throw error;
        // Optional work cannot erase the supported root when no counterevidence arrived.
    }
}
