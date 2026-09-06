import {
    resolveEngineSearchContext,
    type MultiPvResult,
    type StockfishEngine,
} from './stockfishClient';
import { stableCanonicalStringify } from '@/lib/training/contracts';

export type ResidualCoveragePass = {
    nodes: number;
    reference: MultiPvResult;
    residual: MultiPvResult;
    referenceCp?: number;
    residualUpperCp?: number;
};

export type ResidualCoverageExperiment = {
    status: 'EMPTY_RESIDUAL' | 'CP_BOUNDARY_SUPPORTED' | 'PARTIAL';
    reason: string;
    seedId: string;
    legalMovesUci: string[];
    knownMovesUci: string[];
    residualMovesUci: string[];
    coveredMovesUci: string[];
    policyVersion: number;
    maxAcceptedCpLoss: number;
    uncertaintyCp: number;
    passes: ResidualCoveragePass[];
};

/**
 * Optional fixed-seed experiment, deliberately not wired into extraction.
 * A supported result is empirical CP-only evidence for precisely the residual
 * scope. It supplies neither WDL values nor individual move grades, and a
 * consumer must rebase its known assessments onto the recorded reference.
 */
export async function experimentResidualCoverage(args: {
    engine: StockfishEngine;
    fen: string;
    previousFens?: readonly string[];
    seed: { id: string; knownMovesUci: readonly string[] };
    policyVersion: number;
    maxAcceptedCpLoss: number;
    budgets?: readonly number[];
    uncertaintyCp?: number;
    maxReferenceDriftCp?: number;
    signal?: AbortSignal;
}): Promise<ResidualCoverageExperiment> {
    const context = resolveEngineSearchContext(args);
    const known = [...args.seed.knownMovesUci].sort();
    const uncertaintyCp = args.uncertaintyCp ?? 40;
    const maxDrift = args.maxReferenceDriftCp ?? 40;
    const budgets = [...(args.budgets ?? [100_000, 200_000, 400_000])];
    if (!args.seed.id.trim() || !Number.isSafeInteger(args.policyVersion) || args.policyVersion < 1 ||
        ![args.maxAcceptedCpLoss, uncertaintyCp, maxDrift].every(value => Number.isFinite(value) && value >= 0) ||
        new Set(known).size !== known.length || known.some(move => !context.legalRootMoves.includes(move)) ||
        budgets.length < 2 || budgets.length > 8 || budgets.some((nodes, index) =>
            !Number.isSafeInteger(nodes) || nodes < 1 || nodes > 10_000_000 || (index > 0 && nodes <= budgets[index - 1]))) {
        throw new Error('Invalid residual coverage experiment configuration');
    }
    const residual = context.legalRootMoves.filter(move => !known.includes(move));
    const output: ResidualCoverageExperiment = {
        status: residual.length ? 'PARTIAL' : 'EMPTY_RESIDUAL',
        reason: residual.length ? 'INSUFFICIENT_CP_BOUNDARY_EVIDENCE' : 'NO_REMAINING_LEGAL_MOVES',
        seedId: args.seed.id, legalMovesUci: context.legalRootMoves, knownMovesUci: known,
        residualMovesUci: residual, coveredMovesUci: [], policyVersion: args.policyVersion,
        maxAcceptedCpLoss: args.maxAcceptedCpLoss, uncertaintyCp, passes: [],
    };
    if (args.signal?.aborted) throw new Error('Analysis aborted');
    if (!residual.length) return output;
    const ids = new Set<string>();
    let engineIdentity: string | undefined;
    const validEvidence = (result: MultiPvResult, roots: readonly string[], nodes: number, purpose: string): boolean => {
        const evidence = result.searchEvidence;
        if (!evidence || evidence.source !== 'ENGINE' || evidence.reused || !evidence.id || ids.has(evidence.id) ||
            result.fen !== context.fen || result.terminal || evidence.request.fen !== context.fen ||
            evidence.request.purpose !== purpose ||
            evidence.request.historyMode !== (context.previousFens.length ? 'REPLAY' : 'FEN_ONLY') ||
            evidence.request.multiPv !== 1 || evidence.request.limits.nodes !== nodes ||
            evidence.request.limits.depth != null || evidence.request.limits.movetimeMs != null ||
            stableCanonicalStringify(evidence.request.previousFens) !== stableCanonicalStringify(context.previousFens) ||
            stableCanonicalStringify(evidence.request.rootMoves) !== stableCanonicalStringify(roots) ||
            result.lines.length > 1 || result.lines.some(line => line.multipv !== 1 || !roots.includes(line.pvUci[0])) ||
            result.boundLines?.some(line => !roots.includes(line.moveUci))) return false;
        const identity = stableCanonicalStringify(evidence.engine);
        if (engineIdentity && identity !== engineIdentity) return false;
        engineIdentity = identity;
        ids.add(evidence.id);
        return true;
    };
    for (const nodes of budgets) {
        try {
            const limit = { fen: context.fen, previousFens: context.previousFens, multiPv: 1, nodes, reuse: 'FRESH_REQUIRED' as const, signal: args.signal };
            const reference = await args.engine.analyzeMultiPv({ ...limit, purpose: 'RESIDUAL_EXPERIMENT_REFERENCE' });
            const remaining = await args.engine.analyzeMultiPv({ ...limit, rootMoves: residual, purpose: 'RESIDUAL_EXPERIMENT_REMAINDER' });
            if (args.signal?.aborted) throw new Error('Analysis aborted');
            const pass: ResidualCoveragePass = { nodes, reference, residual: remaining };
            output.passes.push(pass);
            if (!validEvidence(reference, context.legalRootMoves, nodes, 'RESIDUAL_EXPERIMENT_REFERENCE') ||
                !validEvidence(remaining, residual, nodes, 'RESIDUAL_EXPERIMENT_REMAINDER')) {
                output.reason = 'SEARCH_SCOPE_OR_PROVENANCE_INVALID';
                return output;
            }
            const referenceLine = reference.lines.find(line => line.multipv === 1);
            const residualLine = remaining.lines.find(line => line.multipv === 1);
            // A per-move bound is not proof of the maximum over many roots.
            // Current adapters retain such bounds without a completed-scope
            // certificate, so only a singleton residual can use one directly.
            const upper = residual.length === 1 ? remaining.boundLines?.find(line => line.bound === 'UPPER' && line.score.type === 'cp') : undefined;
            if (referenceLine?.score?.type !== 'cp') continue;
            pass.referenceCp = referenceLine.score.value;
            pass.residualUpperCp = residualLine?.score?.type === 'cp' ? residualLine.score.value :
                residualLine ? undefined : upper?.score.value;
            if (!Number.isFinite(pass.referenceCp) || !Number.isFinite(pass.residualUpperCp)) continue;
            const previous = output.passes.at(-2);
            if (previous?.referenceCp == null || previous.residualUpperCp == null ||
                Math.abs(pass.referenceCp - previous.referenceCp) > maxDrift) continue;
            const conservativeGap = Math.min(pass.referenceCp, previous.referenceCp) -
                Math.max(pass.residualUpperCp!, previous.residualUpperCp) - uncertaintyCp;
            if (conservativeGap > args.maxAcceptedCpLoss) {
                output.status = 'CP_BOUNDARY_SUPPORTED';
                output.reason = 'PAIRED_CP_GAP_WITH_UNCERTAINTY_MARGIN';
                output.coveredMovesUci = [...residual];
                return output;
            }
        } catch (error) {
            if (args.signal?.aborted) throw error;
            output.reason = 'SEARCH_FAILED';
            return output;
        }
    }
    return output;
}
