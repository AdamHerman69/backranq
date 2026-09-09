import { CORROBORATED_SELECTION_POLICY_ID } from '@/lib/analysis/t2Policy';
import { Chess, type Move } from 'chess.js';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { ruleTerminalEvaluation } from '@/lib/analysis/ruleEvaluation';
import { DEFAULT_ASSESSMENT_POLICY } from '@/lib/training/practiceContract';
import { validateTrainingMomentCandidates } from '@/lib/training/candidateValidation';
import { isStructurallyCompleteMultiPvBundle } from '@/lib/analysis/stockfishClient';
import type { AnalysisSnapshot, EngineWdl, MultiPvLine, MultiPvResult, Score } from '@/lib/analysis/stockfishClient';
import type { StrategyInput, StrategyResult, StudyDecision, StudyGame } from './types';

const uci = (move: Move) => `${move.from}${move.to}${move.promotion ?? ''}`;
export const invertStudyScore = (score: Score): Score => ({ ...score, value: -score.value });
export const invertStudyWdl = (wdl: EngineWdl): EngineWdl => ({ win: wdl.loss, draw: wdl.draw, loss: wdl.win });

/** Full canonical history, including custom PGN starting positions. Never infer player side. */
export function replayStudyGame(source: StudyGame): { moves: Move[]; side: 'w' | 'b'; positions: string[] } {
    const provenance = source.game.provenance;
    if (!provenance || !['white', 'black'].includes(provenance.userSide)
        || provenance.username.toLowerCase() !== source.account.toLowerCase()
        || source.game[provenance.userSide as 'white' | 'black'].name.toLowerCase() !== source.account.toLowerCase()) {
        throw new Error('SOURCE_SIDE_INVALID');
    }
    const board = new Chess();
    board.loadPgn(source.game.pgn, { strict: false });
    const moves = board.history({ verbose: true });
    if (!moves.length) throw new Error('SOURCE_HAS_NO_MOVES');
    const positions = [...moves.map(move => move.before), moves.at(-1)!.after];
    for (let ply = 0; ply < moves.length; ply++) {
        if (ruleTerminalEvaluation(positions[ply], positions.slice(0, ply))) {
            throw new Error(`SOURCE_CONTINUES_AFTER_MANDATORY_END:${ply}`);
        }
    }
    return { moves, positions, side: provenance.userSide === 'white' ? 'w' : 'b' };
}

export function validStudyLine(fen: string, line: MultiPvLine | undefined): boolean {
    if (!line?.score || !Number.isFinite(line.score.value) || !line.pvUci.length) return false;
    if ('bound' in line) return false;
    try {
        const board = new Chess(fen);
        for (const move of line.pvUci) {
            if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return false;
            board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
        }
        return true;
    } catch { return false; }
}

function expected(wdl: EngineWdl | undefined): number | null {
    if (!wdl || [wdl.win, wdl.draw, wdl.loss].some(n => !Number.isFinite(n) || n < 0)) return null;
    const total = wdl.win + wdl.draw + wdl.loss;
    return total > 0 ? (wdl.win + wdl.draw / 2) / total : null;
}

type PointInput = Pick<StudyDecision, 'ply' | 'originalMoveUci' | 'preferredMoveUci' | 'referenceScore' | 'originalScore'
    | 'referenceWdl' | 'originalWdl' | 'comparisonBasis' | 'evidenceIds'>;

/** Research estimate only: no claim of production support or answer readiness. */
export function pointDecision(input: PointInput): StudyDecision {
    const result: StudyDecision = { ...input, candidate: false, admitted: false, estimate: 'UNKNOWN',
        reason: 'MISSING_VALID_EVIDENCE', lossCp: null, lossExpectedScore: null };
    const best = input.referenceScore; const original = input.originalScore;
    if (!best || !original || !input.preferredMoveUci || !Number.isFinite(best.value) || !Number.isFinite(original.value)) return result;
    if (input.originalMoveUci === input.preferredMoveUci) return { ...result, estimate: 'GOOD', reason: 'ORIGINAL_IS_PREFERRED', lossCp: 0, lossExpectedScore: 0 };
    if (best.type !== original.type) return { ...result, candidate: true, reason: 'MIXED_SCORE_KINDS' };
    if (best.type === 'mate' && original.type === 'mate') {
        // mate 0 is ambiguous without an exact terminal certificate; never infer its winner here.
        if (!best.value || !original.value) return { ...result, candidate: true, reason: 'MATE_ZERO_REQUIRES_EXACT_OUTCOME' };
        if (Math.sign(best.value) === Math.sign(original.value)) return { ...result, estimate: 'GOOD', reason: 'SAME_MATE_WINNER' };
        if (best.value < original.value) return { ...result, candidate: true, reason: 'REFERENCE_CONTRADICTION' };
        return { ...result, candidate: true, admitted: true, estimate: 'BELOW_STANDARD', reason: 'ENGINE_MATE_WINNER_LOSS' };
    }
    const lossCp = best.value - original.value;
    const bestE = expected(input.referenceWdl); const originalE = expected(input.originalWdl);
    if ((input.referenceWdl !== undefined || input.originalWdl !== undefined) && (bestE === null || originalE === null)) {
        return { ...result, candidate: true, lossCp, reason: 'WDL_MISSING_OR_INVALID' };
    }
    const lossExpectedScore = bestE === null || originalE === null ? null : bestE - originalE;
    Object.assign(result, { lossCp, lossExpectedScore });
    if (lossCp < 0 || (lossExpectedScore !== null && lossExpectedScore < 0)) return { ...result, candidate: true, reason: 'REFERENCE_CONTRADICTION' };
    result.candidate = lossCp >= 30 || (lossExpectedScore !== null && lossExpectedScore >= 0.03);
    const tolerance = Math.min(300, Math.max(100, 0.6 * Math.max(0, best.value)));
    result.estimate = lossCp > tolerance || (lossExpectedScore !== null && lossExpectedScore > 0.1) ? 'BELOW_STANDARD' : 'GOOD';
    const meaningful = lossExpectedScore === null ? lossCp >= 100 && Math.abs(best.value) < 300 : lossExpectedScore >= 0.08;
    result.admitted = result.estimate === 'BELOW_STANDARD' && meaningful;
    result.reason = result.admitted ? 'POINT_MISTAKE' : result.estimate === 'BELOW_STANDARD' ? 'NO_MEANINGFUL_SELECTION_SIGNAL'
        : result.candidate ? 'POINT_GOOD' : 'BELOW_CANDIDATE_SIGNAL';
    return result;
}

/** T1-only mixed-score estimate. WDL is engine evidence, never a rule-exact certificate. */
export function pointDecisionV2(input: PointInput): StudyDecision {
    const best = input.referenceScore; const original = input.originalScore;
    if (!best || !original || best.type === original.type) return pointDecision(input);
    const unresolved: StudyDecision = { ...input, candidate: true, admitted: false, estimate: 'UNKNOWN',
        lossCp: null, lossExpectedScore: null, reason: 'MIXED_WDL_MISSING_OR_INVALID' };
    if (!input.preferredMoveUci || !Number.isFinite(best.value) || !Number.isFinite(original.value)) {
        return { ...unresolved, reason: 'MISSING_VALID_EVIDENCE' };
    }
    const normalized = (wdl: EngineWdl | undefined) => {
        if (!wdl || !Number.isFinite(wdl.win + wdl.draw + wdl.loss)) return null;
        return expected(wdl);
    };
    const bestE = normalized(input.referenceWdl); const originalE = normalized(input.originalWdl);
    if (bestE === null || originalE === null) return unresolved;
    const mate = best.type === 'mate' ? best : original;
    if (!Number.isInteger(mate.value) || mate.value === 0) return { ...unresolved, reason: 'MIXED_MATE_REQUIRES_NONZERO_DISTANCE' };
    const mateE = best.type === 'mate' ? bestE : originalE;
    if (mateE !== (mate.value > 0 ? 1 : 0)) return { ...unresolved, reason: 'MIXED_MATE_WDL_CONTRADICTION' };
    const lossExpectedScore = bestE - originalE;
    if (lossExpectedScore < 0) return { ...unresolved, lossExpectedScore, reason: 'MIXED_WDL_REFERENCE_CONTRADICTION' };
    if (input.originalMoveUci === input.preferredMoveUci) return { ...unresolved, candidate: false,
        estimate: 'GOOD', lossExpectedScore: 0, reason: 'ORIGINAL_IS_PREFERRED' };
    const below = lossExpectedScore > 0.1;
    return { ...unresolved, candidate: lossExpectedScore >= 0.03, admitted: below,
        estimate: below ? 'BELOW_STANDARD' : 'GOOD', lossExpectedScore,
        reason: below ? 'MIXED_WDL_OUTCOME_LOSS' : 'MIXED_WDL_WITHIN_TOLERANCE' };
}

type Paid = { result: MultiPvResult; fen: string; history: string[]; nodes: number; rootMoves: string[]; multiPv: number };

function validPaid(paid: Paid): boolean {
    const evidence = paid.result.searchEvidence;
    const scope = paid.rootMoves.length ? paid.rootMoves : new Chess(paid.fen).moves({ verbose: true }).map(uci);
    return Boolean(evidence && evidence.source === 'ENGINE' && evidence.request.fen === paid.fen && paid.result.fen === paid.fen
        && JSON.stringify(evidence.request.previousFens) === JSON.stringify(paid.history)
        && JSON.stringify([...evidence.request.rootMoves].sort()) === JSON.stringify([...scope].sort())
        && evidence.request.multiPv === paid.multiPv && evidence.request.limits.nodes === paid.nodes);
}

function finalLines(paid: Paid): MultiPvLine[] {
    if (!validPaid(paid) || paid.result.alternativesComplete !== true) return [];
    const scope = paid.rootMoves.length ? paid.rootMoves : new Chess(paid.fen).moves({ verbose: true }).map(uci);
    if (!isStructurallyCompleteMultiPvBundle(paid.result.lines, paid.multiPv, scope)) return [];
    return paid.result.lines.filter(line => validStudyLine(paid.fen, line) && (!paid.rootMoves.length || paid.rootMoves.includes(line.pvUci[0])));
}

function latestSnapshots(paid: Paid): AnalysisSnapshot[] {
    if (!validPaid(paid)) return [];
    return (paid.result.snapshots ?? []).filter(snapshot => snapshot.bundleComplete && snapshot.searchId === paid.result.searchEvidence!.id
        && snapshot.fen === paid.fen).slice(-2);
}

function boundary(decision: StudyDecision): boolean {
    if (decision.estimate === 'UNKNOWN') return true;
    const cp = decision.referenceScore?.type === 'cp' ? decision.referenceScore.value : null;
    const tolerance = cp === null ? null : Math.min(300, Math.max(100, 0.6 * Math.max(0, cp)));
    return (tolerance !== null && decision.lossCp !== null && Math.abs(decision.lossCp - tolerance) <= 30)
        || (decision.lossExpectedScore !== null && [0.08, 0.1].some(threshold => Math.abs(decision.lossExpectedScore! - threshold) <= 0.03));
}

function referenceDrift(previous: StudyDecision, current: StudyDecision): boolean {
    if (!previous.preferredMoveUci || previous.preferredMoveUci !== current.preferredMoveUci) return false;
    const a = previous.referenceScore; const b = current.referenceScore;
    const aE = expected(previous.referenceWdl); const bE = expected(current.referenceWdl);
    return (a?.type === 'cp' && b?.type === 'cp' && Math.abs(a.value - b.value) > 60)
        || (aE !== null && bE !== null && Math.abs(aE - bE) > 0.06);
}

/** An incomplete extraction is a failed study job, not a negative quality observation. */
export function assertBaselineComplete(
    result: Awaited<ReturnType<typeof extractTrainingMomentsFromGames>>,
    game: StudyGame,
    replay = replayStudyGame(game),
): void {
    const manifest = result.manifests[0];
    const expectedPlies = replay.moves.flatMap((move, ply) => move.color === replay.side ? [ply] : []);
    const receipt = result.analysis?.get(game.game.id)?.trainingExtraction;
    const samePlies = (plies: number[]) => plies.length === expectedPlies.length
        && [...plies].sort((a, b) => a - b).every((ply, index) => ply === expectedPlies[index]);
    if (result.manifests.length !== 1 || !manifest || manifest.version !== 1
        || manifest.scope !== 'FULL_GAME' || manifest.sourceGameId !== game.game.id
        || manifest.sourcePgnHash !== hashSourcePgn(game.game.pgn)
        || !manifest.complete || !manifest.scanComplete || !manifest.extractionComplete
        || manifest.termination !== 'COMPLETED' || manifest.errors.length
        || manifest.expectedPlies !== replay.moves.length || manifest.scannedPlies !== replay.moves.length
        || !samePlies(manifest.decisionOutcomes.map(item => item.decisionPly))) {
        throw new Error('BASELINE_INCOMPLETE_MANIFEST');
    }
    if (!receipt || receipt.version !== 2 || receipt.trainingSide !== (replay.side === 'w' ? 'WHITE' : 'BLACK')
        || !samePlies(receipt.decisions.map(item => item.ply))
        || receipt.summary.userDecisions !== expectedPlies.length
        || manifest.decisionOutcomes.some(outcome => {
            const decision = receipt.decisions.find(item => item.ply === outcome.decisionPly)!;
            const status = decision.status === 'SAVED' ? 'CONFIRMED_MISTAKE'
                : ['FORCED_MOVE', 'ORIGINAL_MOVE_QUALITY_CONFIRMED'].includes(decision.reason) ? 'NOT_A_MISTAKE' : 'UNRESOLVED';
            return outcome.reason !== decision.reason || outcome.status !== status;
        })) {
        throw new Error('BASELINE_INCOMPLETE_RECEIPT');
    }
}

async function baseline(input: StrategyInput, replay: ReturnType<typeof replayStudyGame>): Promise<StrategyResult> {
    const policy = input.profile.mode === 'SINGLE' ? { ...DEFAULT_ASSESSMENT_POLICY,
        id: `${DEFAULT_ASSESSMENT_POLICY.id}:study-single`, minimumCompletedSupportingSearches: 1 } : DEFAULT_ASSESSMENT_POLICY;
    const result = await extractTrainingMomentsFromGames({ games: [input.game.game], selectedGameIds: new Set([input.game.game.id]),
        engine: input.engine, signal: input.signal, options: { selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID, returnAnalysis: true, nodesPerPosition: input.profile.scanNodes,
            confirmNodes: 200_000, maxConfirmationNodes: input.profile.mode === 'THOROUGH' ? 1_600_000 : 800_000,
            multiPv: input.profile.rootMultiPv, gradingPolicy: policy } });
    assertBaselineComplete(result, input.game, replay);
    const receipt = result.analysis!.get(input.game.game.id)!.trainingExtraction!;
    const validation = validateTrainingMomentCandidates(result.moments);
    if (!validation.ok) throw new Error(`BASELINE_MOMENT_VALIDATION_FAILED:${validation.error}`);
    const decisions = replay.moves.flatMap((move, ply): StudyDecision[] => {
        if (move.color !== replay.side) return [];
        const item = receipt?.decisions.find(d => d.ply === ply);
        const moment = result.moments.find(m => m.decisionPly === ply);
        const revision = moment?.solution.manifest;
        const original = revision?.assessments.find(a => a.id === revision.decision.originalAssessmentId);
        return [{ ply, originalMoveUci: uci(move), preferredMoveUci: revision?.rootAnswerIndex.preferredMoveUci ?? null,
            candidate: Boolean(item?.confirmation || item?.reason === 'MISTAKE_CONFIRMED' || item?.reason === 'NO_MEANINGFUL_SELECTION_SIGNAL'),
            admitted: revision?.decision.selection === 'INCLUDED', reason: item?.reason ?? 'MISSING_RECEIPT',
            estimate: original?.quality ?? (item?.reason === 'ORIGINAL_MOVE_QUALITY_CONFIRMED' ? 'GOOD'
                : ['MISTAKE_CONFIRMED', 'NO_MEANINGFUL_SELECTION_SIGNAL'].includes(item?.reason ?? '') ? 'BELOW_STANDARD' : 'UNKNOWN'),
            lossCp: item?.cpLoss ?? null, lossExpectedScore: item?.winChanceLoss ?? null, referenceScore: null, originalScore: null,
            comparisonBasis: 'PRODUCT_POLICY', evidenceIds: item?.confirmation?.passes.flatMap(pass => pass.searchId ? [pass.searchId] : []) ?? [] }];
    });
    return { decisions, productMoments: result.moments.map(moment => ({ momentId: `${moment.sourceGameId}:${moment.decisionPly}`,
        decisionPly: moment.decisionPly, semanticHash: moment.solution.manifest.semanticHash,
        supportedAnswerCount: moment.solution.manifest.assessments.filter(a => a.contextId === moment.solution.manifest.source.contextId
            && a.qualitySupport === 'SUPPORTED' && a.quality !== 'UNKNOWN').length })), errors: result.manifests.flatMap(m => m.errors) };
}

export async function runStrategy(input: StrategyInput): Promise<StrategyResult> {
    input.signal?.throwIfAborted();
    const replay = replayStudyGame(input.game);
    if (['THOROUGH', 'STANDARD', 'SINGLE'].includes(input.profile.mode)) return baseline(input, replay);
    const { profile, engine, signal } = input;
    const priorityOrder = profile.additional === 'TARGETED_PRIORITY';
    const targetedV2 = profile.additional === 'TARGETED_V2' || priorityOrder;
    const targetedMode = profile.additional === 'TARGETED' || targetedV2;
    const scan = new Map<number, Paid>();
    const terminal = new Map<number, NonNullable<ReturnType<typeof ruleTerminalEvaluation>>>();
    const search = async (ply: number, nodes: number, multiPv: number, rootMoves: string[], purpose: string): Promise<Paid> => {
        signal?.throwIfAborted();
        const fen = replay.positions[ply]; const history = replay.positions.slice(0, ply);
        const result = await engine.analyzeMultiPv({ fen, previousFens: history, nodes, multiPv,
            ...(rootMoves.length ? { rootMoves } : {}), purpose, signal, reuse: 'REUSE_ALLOWED' });
        signal?.throwIfAborted();
        return { result, fen, history, nodes, multiPv, rootMoves };
    };
    // Adjacent decision children and roots share exactly one paid canonical scan.
    const needed = new Set(replay.moves.flatMap((move, ply) => move.color === replay.side ? [ply, ply + 1] : []));
    for (const ply of [...needed].sort((a, b) => a - b)) {
        const exact = ruleTerminalEvaluation(replay.positions[ply], replay.positions.slice(0, ply));
        if (exact) terminal.set(ply, exact);
        else scan.set(ply, await search(ply, profile.scanNodes, 1, [], 'STUDY_SCAN'));
    }
    const decisions: StudyDecision[] = [];
    const sources = new Map<number, { root: Paid; original?: Paid }>();
    const compare = (ply: number, root: Paid, original?: Paid, old = false, snapshotSlot?: 0 | 1): StudyDecision => {
        const originalMoveUci = uci(replay.moves[ply]);
        const snapshotLines = (paid: Paid) => {
            const snapshots = latestSnapshots(paid);
            if (snapshots.length !== 2 || (snapshotSlot === undefined && snapshots[1].depth - snapshots[0].depth < 1)) return [];
            const snapshot = snapshots[snapshotSlot ?? (old ? 0 : 1)];
            const snapshotPaid = { ...paid, result: { ...paid.result, searchEvidence: snapshot.searchEvidence, lines: snapshot.lines,
                alternativesComplete: true } };
            return finalLines(snapshotPaid);
        };
        const getLines = (paid: Paid) => profile.mode === 'WINDOW' || snapshotSlot !== undefined ? snapshotLines(paid) : finalLines(paid);
        const rootLines = getLines(root); const best = rootLines.find(line => line.multipv === 1);
        const direct = original ? getLines(original).find(line => line.pvUci[0] === originalMoveUci)
            : rootLines.find(line => line.pvUci[0] === originalMoveUci);
        const child = scan.get(ply + 1); const childLine = child ? getLines(child).find(line => line.multipv === 1) : undefined;
        const exact = terminal.get(ply + 1);
        const originalScore = direct?.score ?? (original ? null : exact?.score ? invertStudyScore(exact.score)
            : childLine?.score ? invertStudyScore(childLine.score) : null);
        const originalWdl = direct ? direct.wdl : (!original && (exact?.wdl ?? childLine?.wdl) ? invertStudyWdl((exact?.wdl ?? childLine?.wdl)!) : undefined);
        return (targetedV2 ? pointDecisionV2 : pointDecision)({ ply, originalMoveUci, preferredMoveUci: best?.pvUci[0] ?? null,
            referenceScore: best?.score ?? null, originalScore, referenceWdl: best?.wdl, originalWdl,
            comparisonBasis: direct || original ? 'SAME_ROOT' : 'PARENT_CHILD_SCAN',
            evidenceIds: [root.result.searchEvidence?.id, original?.result.searchEvidence?.id,
                !direct && !original ? child?.result.searchEvidence?.id ?? exact?.searchEvidence?.id : undefined].filter((id): id is string => Boolean(id)) });
    };
    const evaluate = (ply: number, root: Paid, original?: Paid) => {
        const decision = compare(ply, root, original);
        if (profile.mode !== 'WINDOW') return decision;
        const previous = compare(ply, root, original, true);
        if (previous.estimate === 'UNKNOWN' || decision.estimate === 'UNKNOWN' || previous.estimate !== decision.estimate || previous.admitted !== decision.admitted) {
            return { ...decision, admitted: false, estimate: 'UNKNOWN' as const, reason: 'WINDOW_UNRESOLVED' };
        }
        return { ...decision, reason: decision.admitted ? 'WINDOW_MISTAKE' : decision.reason };
    };
    for (const [ply, move] of replay.moves.entries()) {
        if (move.color !== replay.side) continue;
        const root = scan.get(ply)!;
        sources.set(ply, { root });
        let decision = evaluate(ply, root);
        if (new Chess(move.before).moves().length === 1) decision = { ...decision, candidate: false, admitted: false, reason: 'FORCED_MOVE' };
        decisions.push(decision);
    }
    const candidates = decisions.filter(d => targetedMode || d.candidate || d.estimate === 'UNKNOWN').sort((a, b) => {
        if (!priorityOrder) return (b.lossExpectedScore ?? (b.lossCp ?? 0) / 1000) - (a.lossExpectedScore ?? (a.lossCp ?? 0) / 1000) || a.ply - b.ply;
        if (a.admitted !== b.admitted) return a.admitted ? -1 : 1;
        const distance = (decision: StudyDecision) => decision.lossExpectedScore !== null && Number.isFinite(decision.lossExpectedScore)
            ? Math.abs(decision.lossExpectedScore - 0.1) : Infinity;
        const aDistance = distance(a); const bDistance = distance(b);
        return aDistance === bDistance ? a.ply - b.ply : aDistance - bDistance;
    });
    let postSpent = 0;
    for (const initial of candidates) {
        if (profile.additional === 'NONE' || initial.reason === 'FORCED_MOVE') continue;
        if (targetedMode) {
            const { root } = sources.get(initial.ply)!;
            const triggers: NonNullable<StudyDecision['targetedVerification']>['triggers'] = [];
            const cpTolerance = initial.referenceScore?.type === 'cp'
                ? Math.min(300, Math.max(100, 0.6 * Math.max(0, initial.referenceScore.value))) : null;
            const wdlOnly = targetedV2 ? cpTolerance !== null && initial.lossCp !== null && initial.lossCp <= cpTolerance
                : initial.lossCp !== null && initial.lossCp < 75;
            if (initial.admitted && wdlOnly && initial.lossExpectedScore !== null && initial.lossExpectedScore > 0.1) {
                triggers.push(targetedV2 ? 'WDL_ONLY' : 'WDL_LOW_CP');
            }
            const earlier = compare(initial.ply, root, undefined, false, 0);
            const latest = compare(initial.ply, root, undefined, false, 1);
            const unresolvedV2 = targetedV2 && initial.estimate === 'UNKNOWN';
            if (!unresolvedV2 && earlier.estimate !== 'UNKNOWN' && latest.estimate !== 'UNKNOWN'
                && earlier.admitted !== latest.admitted) triggers.push('SCAN_ACCEPTANCE_DISAGREEMENT');
            if (!targetedV2 && ['MIXED_SCORE_KINDS', 'REFERENCE_CONTRADICTION'].includes(initial.reason)) triggers.push('SEMANTIC_CONFLICT');
            const verification: NonNullable<StudyDecision['targetedVerification']> = {
                triggers, outcome: 'NOT_TRIGGERED', requestedNodes: 0, searchIds: [],
                scanSnapshotIds: [root, scan.get(initial.ply + 1)].flatMap(paid => paid ? latestSnapshots(paid).map(s => s.id) : []),
                initial: { admitted: initial.admitted, estimate: initial.estimate, reason: initial.reason,
                    lossCp: initial.lossCp, lossExpectedScore: initial.lossExpectedScore },
            };
            let current = initial;
            if (triggers.length) {
                const nodes = profile.rounds[0];
                const canSpend = () => postSpent + nodes <= profile.postScanGameNodes
                    && verification.requestedNodes + nodes <= profile.postScanCandidateNodes;
                const dispatch = async (rootMoves: string[], multiPv: number, purpose: string) => {
                    postSpent += nodes; verification.requestedNodes += nodes;
                    const paid = await search(initial.ply, nodes, multiPv, rootMoves, purpose);
                    if (paid.result.searchEvidence?.id) verification.searchIds.push(paid.result.searchEvidence.id);
                    return paid;
                };
                let updatedRoot = root;
                let targetedOriginal: Paid | undefined;
                if (root.nodes < nodes || root.multiPv < profile.rootMultiPv || !finalLines(root).length) {
                    if (canSpend()) updatedRoot = await dispatch([], profile.rootMultiPv, 'STUDY_TARGETED_ROOT');
                    else verification.outcome = 'SKIPPED_BUDGET';
                }
                if (verification.outcome !== 'SKIPPED_BUDGET') {
                    if (!finalLines(updatedRoot).length) verification.outcome = 'INVALID_VERIFICATION';
                    else if (!finalLines(updatedRoot).some(line => line.pvUci[0] === initial.originalMoveUci)) {
                        if (canSpend()) targetedOriginal = await dispatch([initial.originalMoveUci], 1, 'STUDY_TARGETED_ORIGINAL');
                        else verification.outcome = 'SKIPPED_BUDGET';
                    }
                }
                if (verification.outcome === 'NOT_TRIGGERED') {
                    if (targetedOriginal && !finalLines(targetedOriginal).length) verification.outcome = 'INVALID_VERIFICATION';
                    else {
                        current = compare(initial.ply, updatedRoot, targetedOriginal);
                        verification.outcome = current.estimate === 'UNKNOWN' ? 'UNRESOLVED' : 'VERIFIED';
                    }
                }
                current = { ...current, reason: `${current.reason}:TARGETED_${verification.outcome}` };
            }
            decisions[decisions.findIndex(d => d.ply === initial.ply)] = { ...current, targetedVerification: verification };
            continue;
        }
        let current = initial; let candidateSpent = 0;
        let conflict = false;
        let { root, original } = sources.get(initial.ply)!;
        for (const nodes of profile.rounds) {
            if (profile.additional === 'ADAPTIVE' && !boundary(current) && !conflict) break;
            // A full-root scan with one line cannot replace a requested five-line root search.
            const needRoot = root.nodes < nodes || root.multiPv < profile.rootMultiPv || !finalLines(root).length;
            const direct = finalLines(root).find(line => line.pvUci[0] === current.originalMoveUci);
            const needOriginal = (needRoot || !direct) && (!original || original.nodes < nodes || !finalLines(original).length);
            const required = (Number(needRoot) + Number(needOriginal)) * nodes;
            if (postSpent + required > profile.postScanGameNodes || candidateSpent + required > profile.postScanCandidateNodes) {
                current = { ...current, reason: `${current.reason}:POLICY_BUDGET_EXHAUSTED` }; break;
            }
            if (needRoot) { postSpent += nodes; candidateSpent += nodes; root = await search(initial.ply, nodes, profile.rootMultiPv, [], 'STUDY_ROOT'); }
            // Reuse newly paid root evidence if it already includes the original move.
            if (finalLines(root).some(line => line.pvUci[0] === current.originalMoveUci)) original = undefined;
            else if (needOriginal) { postSpent += nodes; candidateSpent += nodes; original = await search(initial.ply, nodes, 1, [current.originalMoveUci], 'STUDY_ORIGINAL'); }
            const next = evaluate(initial.ply, root, original);
            conflict = referenceDrift(current, next);
            current = conflict ? { ...next, reason: `${next.reason}:REFERENCE_DRIFT` } : next;
            if (profile.additional === 'PAIR_ONCE') break;
        }
        decisions[decisions.findIndex(d => d.ply === initial.ply)] = current;
    }
    return { decisions, productMoments: [], errors: [] };
}
