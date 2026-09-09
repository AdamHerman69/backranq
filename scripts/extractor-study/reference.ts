/** Research-only finite reference audit. No production moment is emitted here. */
import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import type { AuditSample, ReferenceResult, StudyConfig, StudyGame } from './types';

export type SampledPly = Omit<AuditSample, 'decision' | 'strictQuality' | 'alternatives'>;

/** Uniform hash ranking within disjoint strata. Empty strata do not donate quota. */
export function sampleReferencePlies(args: {
    seed: string; gameId: string; positionsPerGame: number;
    playerPlies: number[]; admittedPlies: number[]; candidatePlies: number[];
}): SampledPly[] {
    if (!Number.isInteger(args.positionsPerGame) || args.positionsPerGame < 3 || args.positionsPerGame % 3) {
        throw new Error('Reference positionsPerGame must be a positive multiple of three');
    }
    const admitted = new Set(args.admittedPlies), candidates = new Set(args.candidatePlies);
    const strata: Record<SampledPly['stratum'], number[]> = { ADMITTED: [], CANDIDATE: [], OTHER: [] };
    for (const ply of [...new Set(args.playerPlies)].sort((a, b) => a - b)) {
        if (!Number.isInteger(ply) || ply < 0) throw new Error('Invalid reference player ply');
        strata[admitted.has(ply) ? 'ADMITTED' : candidates.has(ply) ? 'CANDIDATE' : 'OTHER'].push(ply);
    }
    const rank = (ply: number) => createHash('sha256').update(JSON.stringify([args.seed, args.gameId, ply])).digest('hex');
    const samples: SampledPly[] = [];
    for (const stratum of ['ADMITTED', 'CANDIDATE', 'OTHER'] as const) {
        const population = strata[stratum].length;
        const count = Math.min(population, args.positionsPerGame / 3);
        const chosen = strata[stratum].sort((a, b) => rank(a).localeCompare(rank(b)) || a - b).slice(0, count);
        for (const ply of chosen) samples.push({ ply, stratum, population, inclusionProbability: count / population });
    }
    return samples.sort((a, b) => a.ply - b.ply);
}

import type { EvalResult, MultiPvLine, MultiPvResult, StockfishEngine } from '@/lib/analysis/stockfishClient';
import { PositionAnalysisPool } from '@/lib/analysis/positionAnalysisPool';
import { assessPracticePosition } from '@/lib/analysis/practiceMomentBuilder';
import { ruleTerminalEvaluation } from '@/lib/analysis/ruleEvaluation';
import { replayStudyGame, pointDecision, validStudyLine, invertStudyScore, invertStudyWdl } from './strategies';
import type { StudyDecision } from './types';

const asLine = (result: EvalResult): MultiPvLine => ({ multipv: 1, score: result.score,
    pvUci: result.pvUci, wdl: result.wdl, depth: result.depth, nodes: result.nodes });
const evidenceId = (result: EvalResult | MultiPvResult) => result.searchEvidence ? [result.searchEvidence.id] : [];
const legalUci = (fen: string) => new Chess(fen).moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
function attributable(result: EvalResult | MultiPvResult, fen: string, history: string[], nodes: number, multiPv: number, roots = legalUci(fen)): boolean {
    const evidence = result.searchEvidence;
    return Boolean(evidence?.source === 'ENGINE' && result.fen === fen && evidence.request.fen === fen
        && evidence.request.limits.nodes === nodes && evidence.request.multiPv === multiPv
        && JSON.stringify(evidence.request.previousFens) === JSON.stringify(history)
        && JSON.stringify([...evidence.request.rootMoves].sort()) === JSON.stringify([...roots].sort()));
}


/** Caller supplies a fresh game-level engine session and owns the global work limits. */
export async function runReference(args: {
    game: StudyGame; config: StudyConfig; engine: StockfishEngine;
    admittedPlies: number[]; candidatePlies: number[]; signal?: AbortSignal;
}): Promise<ReferenceResult> {
    if (!args.config.reference.enabled) return { samples: [], scanCandidates: [], errors: [] };
    const count = args.config.reference.positionsPerGame;
    if (!Number.isInteger(count) || count < 3 || count % 3) throw new Error('Reference positionsPerGame must be a positive multiple of three');
    const { moves, side, positions } = replayStudyGame(args.game);
    const scans: EvalResult[] = [];
    const scanCandidates: number[] = [];
    const pool = new PositionAnalysisPool();
    // Separate pool captures honest evidence for the strict-policy secondary projection.
    const engine = pool.wrap(args.engine);
    const history = (ply: number) => positions.slice(0, ply);
    for (let ply = 0; ply < positions.length; ply++) {
        args.signal?.throwIfAborted();
        const fen = positions[ply];
        scans.push(ruleTerminalEvaluation(fen, history(ply)) ?? await engine.evalPosition({
            fen, previousFens: history(ply), nodes: args.config.reference.scanNodes,
            reuse: 'FRESH_REQUIRED', purpose: 'SCAN', signal: args.signal,
        }));
    }
    const playerPlies: number[] = [];
    for (let ply = 0; ply < moves.length; ply++) {
        const move = moves[ply];
        if (move.color !== side) continue;
        playerPlies.push(ply);
        const original = `${move.from}${move.to}${move.promotion ?? ''}`;
        const parent = scans[ply], child = scans[ply + 1];
        const validParent = attributable(parent, move.before, history(ply), args.config.reference.scanNodes, 1)
            && parent.bestMoveUci === parent.pvUci[0] && validStudyLine(move.before, asLine(parent));
        const validChild = child.fen === move.after && (!!child.terminal || (attributable(child, move.after, history(ply + 1), args.config.reference.scanNodes, 1) && validStudyLine(move.after, asLine(child))));
        const preferred = validParent ? parent.bestMoveUci : null;
        const isPreferred = preferred === original;
        const candidate = pointDecision({ ply, originalMoveUci: original, preferredMoveUci: preferred,
            referenceScore: validParent ? parent.score : null,
            originalScore: isPreferred ? parent.score : validChild && child.score ? invertStudyScore(child.score) : null,
            referenceWdl: validParent ? parent.wdl : undefined,
            originalWdl: isPreferred ? parent.wdl : validChild && child.wdl ? invertStudyWdl(child.wdl) : undefined,
            comparisonBasis: 'PARENT_CHILD_SCAN', evidenceIds: [...evidenceId(parent), ...evidenceId(child)],
        });
        if (candidate.candidate) scanCandidates.push(ply);
    }
    const selected = sampleReferencePlies({ seed: args.config.seed, gameId: args.game.game.id,
        positionsPerGame: args.config.reference.positionsPerGame, playerPlies,
        admittedPlies: args.admittedPlies, candidatePlies: [...args.candidatePlies, ...scanCandidates] });
    const samples = await auditSelectedPositions(args, { moves, side, positions }, selected, pool, engine);
    return { samples, scanCandidates, errors: [] };
}

type AuditInput = {
    game: StudyGame; config: StudyConfig; engine: StockfishEngine; signal?: AbortSignal;
};

/**
 * Audit every position in an explicitly selected set, without a whole-game scan.
 * Repeated plies are deduplicated before work; output is sorted by canonical ply.
 * ADMITTED is only the compatible stratum tag: population and probability describe
 * the exhaustive targeted set, never a random sample or population error rate.
 * Caller supplies a fresh engine session and preserves any outer evidence pool.
 */
export async function auditReferencePositions(args: AuditInput & { plies: number[] }): Promise<AuditSample[]> {
    args.signal?.throwIfAborted();
    const replay = replayStudyGame(args.game);
    if (args.plies.some(ply => !Number.isInteger(ply) || ply < 0 || ply >= replay.moves.length
        || replay.moves[ply].color !== replay.side)) throw new Error('Invalid targeted reference player ply');
    if (!args.config.reference.enabled) return [];
    const plies = [...new Set(args.plies)].sort((a, b) => a - b);
    const selected: SampledPly[] = plies.map(ply => ({ ply, stratum: 'ADMITTED',
        population: plies.length, inclusionProbability: 1 }));
    const pool = new PositionAnalysisPool();
    return auditSelectedPositions(args, replay, selected, pool, pool.wrap(args.engine));
}

async function auditSelectedPositions(args: AuditInput,
    { moves, side, positions }: ReturnType<typeof replayStudyGame>, selected: SampledPly[],
    pool: PositionAnalysisPool, engine: StockfishEngine): Promise<AuditSample[]> {
    const history = (ply: number) => positions.slice(0, ply);
    const samples: AuditSample[] = [];
    for (const sample of selected) {
        args.signal?.throwIfAborted();
        const move = moves[sample.ply], fen = move.before;
        const original = `${move.from}${move.to}${move.promotion ?? ''}`;
        const previousFens = history(sample.ply);
        const options = { fen, previousFens, reuse: 'FRESH_REQUIRED' as const, signal: args.signal };
        const root = await engine.analyzeMultiPv({ ...options, multiPv: 5,
            nodes: args.config.reference.rootNodes, purpose: 'MISSING_REFERENCE' });
        const line = root.lines[0];
        const preferred = validStudyLine(fen, line) ? line.pvUci[0] : null;
        const ids = evidenceId(root);
        let probe: EvalResult | null = null, originalResult: EvalResult | null = null;
        if (preferred) {
            probe = await engine.evalPosition({ ...options, rootMoves: [preferred],
                nodes: args.config.reference.moveNodes, purpose: 'VERIFY_REFERENCE' });
            ids.push(...evidenceId(probe));
            originalResult = original === preferred ? probe : await engine.evalPosition({
                ...options, rootMoves: [original], nodes: args.config.reference.moveNodes, purpose: 'MISSING_MOVE' });
            ids.push(...evidenceId(originalResult));
        }
        const legal = legalUci(fen);
        const validRoot = attributable(root, fen, previousFens, args.config.reference.rootNodes, 5)
            && root.bestMoveUci === preferred && root.alternativesComplete === true && !!preferred
            && root.lines.length === Math.min(5, legal.length)
            && new Set(root.lines.map(l => l.pvUci[0])).size === root.lines.length
            && root.lines.every((l, i) => l.multipv === i + 1 && validStudyLine(fen, l));
        const probeLine = probe ? asLine(probe) : undefined;
        const originalLine = originalResult ? asLine(originalResult) : undefined;
        const validProbe = !!probe && !!preferred && attributable(probe, fen, previousFens, args.config.reference.moveNodes, 1, [preferred]) && probe.bestMoveUci === preferred && validStudyLine(fen, probeLine) && probeLine?.pvUci[0] === preferred;
        const validOriginal = !!originalResult && attributable(originalResult, fen, previousFens, args.config.reference.moveNodes, 1, [original]) && originalResult.bestMoveUci === original && validStudyLine(fen, originalLine) && originalLine?.pvUci[0] === original;
        const decisionFor = (target: MultiPvLine | undefined, moveUci: string, focus: boolean): StudyDecision => pointDecision({
            ply: sample.ply, originalMoveUci: moveUci, preferredMoveUci: preferred,
            referenceScore: validRoot && validProbe ? (focus ? probeLine!.score : line.score) : null,
            referenceWdl: validRoot && validProbe ? (focus ? probeLine!.wdl : line.wdl) : undefined,
            originalScore: target && validStudyLine(fen, target) ? target.score : null,
            originalWdl: target && validStudyLine(fen, target) ? target.wdl : undefined,
            comparisonBasis: 'SAME_ROOT', evidenceIds: [...new Set(ids)],
        });
        const reconcile = (target: MultiPvLine | undefined, moveUci: string) => {
            const full = decisionFor(target, moveUci, false), focused = decisionFor(target, moveUci, true);
            if (full.estimate !== focused.estimate) return { ...focused, admitted: false,
                estimate: 'UNKNOWN' as const, reason: 'REFERENCE_QUALITY_CONTRADICTION' };
            return focused;
        };
        let decision = reconcile(validOriginal ? originalLine : undefined, original);
        if (!validRoot || !validProbe || !validOriginal) decision = { ...decision, admitted: false,
            estimate: 'UNKNOWN', reason: 'INCOMPLETE_REFERENCE_EVIDENCE' };
        const strict = assessPracticePosition({ pool, fen, positionHistory: previousFens,
            trainingSide: side === 'w' ? 'WHITE' : 'BLACK', originalMoveUci: original,
            minimumConfirmationNodes: args.config.reference.rootNodes });
        const strictOriginal = strict?.assessments.find(a => a.moveUci === original);
        const strictReference = strict?.assessments.find(a => a.moveUci === preferred);
        const strictQuality = strictOriginal?.qualitySupport === 'SUPPORTED'
            && strictReference?.qualitySupport === 'SUPPORTED' && strictReference.quality === 'GOOD'
            ? strictOriginal.quality : 'UNKNOWN';
        const alternatives = validRoot ? root.lines.map(alternative => {
            const moveUci = alternative.pvUci[0];
            const target = moveUci === original ? (validOriginal ? originalLine : undefined)
                : moveUci === preferred ? (validProbe ? probeLine : undefined) : alternative;
            return { moveUci, estimate: reconcile(target, moveUci).estimate };
        }) : [];
        samples.push({ ...sample, decision, strictQuality, alternatives });
    }
    return samples;
}
