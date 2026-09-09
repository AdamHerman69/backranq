import { Chess, type Move } from 'chess.js';
import type { NormalizedGame } from '@/lib/types/game';
import { resolveGameAnalysisProvenance } from '@/lib/games/analysisProvenance';
import { ruleTerminalEvaluation } from './ruleEvaluation';
import { isStructurallyCompleteMultiPvBundle, type AnalysisSnapshot, type MultiPvLine, type MultiPvResult, type StockfishEngine } from './stockfishClient';
import type { PositionAnalysisPool } from './positionAnalysisPool';
import { computeT2PointDecision, invertT2Score, invertT2Wdl, validT2Line, T2_BUDGETS, type T2PointDecision } from './t2Policy';
const uci = (move: Move) => `${move.from}${move.to}${move.promotion ?? ''}`;

export type T2Replay = { moves: Move[]; side: 'w' | 'b'; positions: string[] };
export function replayT2Game(game: NormalizedGame): T2Replay {
    const provenance = resolveGameAnalysisProvenance(game);
    if (!provenance) throw new Error('SOURCE_SIDE_INVALID');
    const board = new Chess();
    board.loadPgn(game.pgn, { strict: false });
    const moves = board.history({ verbose: true });
    if (!moves.length) throw new Error('SOURCE_HAS_NO_MOVES');
    const positions = [...moves.map(move => move.before), moves.at(-1)!.after];
    for (let ply = 0; ply < moves.length; ply++) {
        if (ruleTerminalEvaluation(positions[ply], positions.slice(0, ply))) throw new Error(`SOURCE_CONTINUES_AFTER_MANDATORY_END:${ply}`);
    }
    return { moves, positions, side: provenance.userColor };
}

/** Query boundaries are checkpoint boundaries; a targeted pair completes atomically. */
export type T2StrategyState = {
    version: 1;
    phase: 'SCAN' | 'VERIFY' | 'COMPLETE';
    nextScanIndex: number;
    scanSearchIds: Array<[number, string]>;
    decisions: T2PointDecision[];
    candidatePlies: number[];
    nextCandidateIndex: number;
    postSpent: number;
};
export type T2StrategyResult = { state: T2StrategyState; stopped: boolean; yielded: boolean };
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
    // Transport the same completed point that the selector used into the persisted contract.
    const latest = (paid.result.snapshots ?? []).filter(s => s.bundleComplete && s.searchId === paid.result.searchEvidence?.id).at(-1);
    const point = (lines: MultiPvLine[]) => JSON.stringify(lines.map(line => [line.multipv, line.score, line.wdl ?? null, line.pvUci]));
    if (!latest || point(latest.lines) !== point(paid.result.lines)) return [];
    const scope = paid.rootMoves.length ? paid.rootMoves : new Chess(paid.fen).moves({ verbose: true }).map(uci);
    if (!isStructurallyCompleteMultiPvBundle(paid.result.lines, paid.multiPv, scope)) return [];
    return paid.result.lines.filter(line => validT2Line(paid.fen, line) && (!paid.rootMoves.length || paid.rootMoves.includes(line.pvUci[0])));
}

function latestSnapshots(paid: Paid): AnalysisSnapshot[] {
    if (!validPaid(paid)) return [];
    return (paid.result.snapshots ?? []).filter(snapshot => snapshot.bundleComplete && snapshot.searchId === paid.result.searchEvidence!.id
        && snapshot.fen === paid.fen).slice(-2);
}


export async function runT2Game(input: {
    replay: T2Replay; engine: StockfishEngine; pool: PositionAnalysisPool;
    signal?: AbortSignal; timeoutMs?: number; state?: T2StrategyState; shouldYield?: () => boolean;
    onProgress?: (ply: number, phase: 'scanning' | 'confirming') => void;
    onDecision?: (decision: T2PointDecision) => Promise<boolean>;
}): Promise<T2StrategyResult> {
    const { replay, engine, signal } = input;
    const state: T2StrategyState = input.state ? structuredClone(input.state) : {
        version: 1, phase: 'SCAN', nextScanIndex: 0, scanSearchIds: [], decisions: [], candidatePlies: [], nextCandidateIndex: 0, postSpent: 0,
    };
    const scan = new Map<number, Paid>();
    const terminal = new Map<number, NonNullable<ReturnType<typeof ruleTerminalEvaluation>>>();
    const searches = new Map(input.pool.serialize().searches.map(paid => [paid.evidence.id, paid]));
    for (const [ply, id] of state.scanSearchIds) {
        const paid = searches.get(id);
        if (!paid?.result) throw new Error('T2 checkpoint lost scan evidence');
        scan.set(ply, { result: { ...paid.result, snapshots: paid.snapshots }, fen: replay.positions[ply], history: replay.positions.slice(0, ply),
            nodes: T2_BUDGETS.scanNodes, rootMoves: [], multiPv: 1 });
    }
    const search = async (ply: number, nodes: number, multiPv: number, rootMoves: string[], purpose: string): Promise<Paid> => {
        signal?.throwIfAborted();
        input.onProgress?.(ply, purpose === 'T2_SCAN' ? 'scanning' : 'confirming');
        const fen = replay.positions[ply]; const history = replay.positions.slice(0, ply);
        const result = await engine.analyzeMultiPv({ fen, previousFens: history, nodes, multiPv,
            ...(rootMoves.length ? { rootMoves } : {}), purpose, timeoutMs: input.timeoutMs, signal, reuse: 'REUSE_ALLOWED' });
        signal?.throwIfAborted();
        return { result, fen, history, nodes, multiPv, rootMoves };
    };
    const needed = [...new Set(replay.moves.flatMap((move, ply) => move.color === replay.side ? [ply, ply + 1] : []))].sort((a, b) => a - b);
    for (const ply of needed) {
        const exact = ruleTerminalEvaluation(replay.positions[ply], replay.positions.slice(0, ply));
        if (exact) { terminal.set(ply, exact); input.pool.recordResult(exact); }
    }
    if (state.phase === 'SCAN') {
        for (let index = state.nextScanIndex; index < needed.length; index++) {
            const ply = needed[index];
            if (!terminal.has(ply)) {
                const paid = await search(ply, T2_BUDGETS.scanNodes, 1, [], 'T2_SCAN');
                const id = paid.result.searchEvidence?.id;
                if (!id) throw new Error('T2 scan is missing search identity');
                scan.set(ply, paid); state.scanSearchIds.push([ply, id]);
            }
            state.nextScanIndex = index + 1;
            if (input.shouldYield?.()) return { state, yielded: true, stopped: false };
        }
    }
    const compare = (ply: number, root: Paid, original?: Paid, old = false, snapshotSlot?: 0 | 1): T2PointDecision => {
        const originalMoveUci = uci(replay.moves[ply]);
        const snapshotLines = (paid: Paid) => {
            const snapshots = latestSnapshots(paid);
            if (snapshots.length !== 2 || (snapshotSlot === undefined && snapshots[1].depth - snapshots[0].depth < 1)) return [];
            const snapshot = snapshots[snapshotSlot ?? (old ? 0 : 1)];
            const snapshotPaid = { ...paid, result: { ...paid.result, searchEvidence: snapshot.searchEvidence, lines: snapshot.lines,
                alternativesComplete: true, snapshots: [snapshot] } };
            return finalLines(snapshotPaid);
        };
        const getLines = (paid: Paid) => snapshotSlot !== undefined ? snapshotLines(paid) : finalLines(paid);
        const rootLines = getLines(root); const best = rootLines.find(line => line.multipv === 1);
        const direct = original ? getLines(original).find(line => line.pvUci[0] === originalMoveUci)
            : rootLines.find(line => line.pvUci[0] === originalMoveUci);
        const child = scan.get(ply + 1); const childLine = child ? getLines(child).find(line => line.multipv === 1) : undefined;
        const exact = terminal.get(ply + 1);
        const originalScore = direct?.score ?? (original ? null : exact?.score ? invertT2Score(exact.score)
            : childLine?.score ? invertT2Score(childLine.score) : null);
        const originalWdl = direct ? direct.wdl : (!original && (exact?.wdl ?? childLine?.wdl) ? invertT2Wdl((exact?.wdl ?? childLine?.wdl)!) : undefined);
        return computeT2PointDecision({ ply, originalMoveUci, preferredMoveUci: best?.pvUci[0] ?? null,
            referenceScore: best?.score ?? null, originalScore, referenceWdl: best?.wdl, originalWdl,
            comparisonBasis: direct || original ? 'SAME_ROOT' : 'PARENT_CHILD_SCAN',
            evidenceIds: [root.result.searchEvidence?.id, original?.result.searchEvidence?.id,
                !direct && !original ? child?.result.searchEvidence?.id ?? exact?.searchEvidence?.id : undefined].filter((id): id is string => Boolean(id)) });
    };

    const decisions = state.decisions;
    if (state.phase === 'SCAN') {
        for (const [ply, move] of replay.moves.entries()) {
            if (move.color !== replay.side) continue;
            let decision = compare(ply, scan.get(ply)!);
            if (new Chess(move.before).moves().length === 1) decision = { ...decision, candidate: false, admitted: false, reason: 'FORCED_MOVE' };
            decisions.push(decision);
        }
        state.candidatePlies = [...decisions].sort((a, b) => {
            if (a.admitted !== b.admitted) return a.admitted ? -1 : 1;
            const distance = (decision: T2PointDecision) => decision.lossExpectedScore !== null && Number.isFinite(decision.lossExpectedScore)
                ? Math.abs(decision.lossExpectedScore - 0.1) : Infinity;
            const aDistance = distance(a); const bDistance = distance(b);
            return aDistance === bDistance ? a.ply - b.ply : aDistance - bDistance;
        }).map(d => d.ply);
        state.phase = 'VERIFY';
    }
    if (state.phase === 'VERIFY') {
        for (let index = state.nextCandidateIndex; index < state.candidatePlies.length; index++) {
            signal?.throwIfAborted();
            const initial = decisions.find(d => d.ply === state.candidatePlies[index])!;
            if (initial.reason !== 'FORCED_MOVE') {
            const root = scan.get(initial.ply)!;
            const triggers: NonNullable<T2PointDecision['targetedVerification']>['triggers'] = [];
            const cpTolerance = initial.referenceScore?.type === 'cp'
                ? Math.min(300, Math.max(100, 0.6 * Math.max(0, initial.referenceScore.value))) : null;
            const wdlOnly = cpTolerance !== null && initial.lossCp !== null && initial.lossCp <= cpTolerance;
            if (initial.admitted && wdlOnly && initial.lossExpectedScore !== null && initial.lossExpectedScore > 0.1) {
                triggers.push('WDL_ONLY');
            }
            const earlier = compare(initial.ply, root, undefined, false, 0);
            const latest = compare(initial.ply, root, undefined, false, 1);
            const unresolvedV2 = initial.estimate === 'UNKNOWN';
            if (!unresolvedV2 && earlier.estimate !== 'UNKNOWN' && latest.estimate !== 'UNKNOWN'
                && earlier.admitted !== latest.admitted) triggers.push('SCAN_ACCEPTANCE_DISAGREEMENT');
            const verification: NonNullable<T2PointDecision['targetedVerification']> = {
                triggers, outcome: 'NOT_TRIGGERED', requestedNodes: 0, searchIds: [],
                scanSnapshotIds: [root, scan.get(initial.ply + 1)].flatMap(paid => paid ? latestSnapshots(paid).map(s => s.id) : []),
                initial: { admitted: initial.admitted, estimate: initial.estimate, reason: initial.reason,
                    lossCp: initial.lossCp, lossExpectedScore: initial.lossExpectedScore },
            };
            let current = initial;
            if (triggers.length) {
                const nodes = T2_BUDGETS.confirmationNodes;
                const canSpend = () => state.postSpent + nodes <= T2_BUDGETS.gameNodes
                    && verification.requestedNodes + nodes <= T2_BUDGETS.candidateNodes;
                const dispatch = async (rootMoves: string[], multiPv: number, purpose: string) => {
                    state.postSpent += nodes; verification.requestedNodes += nodes;
                    const paid = await search(initial.ply, nodes, multiPv, rootMoves, purpose);
                    if (paid.result.searchEvidence?.id) verification.searchIds.push(paid.result.searchEvidence.id);
                    return paid;
                };
                let updatedRoot = root;
                let targetedOriginal: Paid | undefined;
                if (root.nodes < nodes || root.multiPv < T2_BUDGETS.rootMultiPv || !finalLines(root).length) {
                    if (canSpend()) updatedRoot = await dispatch([], T2_BUDGETS.rootMultiPv, 'T2_TARGETED_ROOT');
                    else verification.outcome = 'SKIPPED_BUDGET';
                }
                if (verification.outcome !== 'SKIPPED_BUDGET') {
                    if (!finalLines(updatedRoot).length) verification.outcome = 'INVALID_VERIFICATION';
                    else if (!finalLines(updatedRoot).some(line => line.pvUci[0] === initial.originalMoveUci)) {
                        if (canSpend()) targetedOriginal = await dispatch([initial.originalMoveUci], 1, 'T2_TARGETED_ORIGINAL');
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

            }
            state.nextCandidateIndex = index + 1;
            const final = decisions.find(d => d.ply === initial.ply)!;
            if (await input.onDecision?.(final)) return { state, yielded: false, stopped: true };
            if (input.shouldYield?.()) return { state, yielded: true, stopped: false };
        }
        state.phase = 'COMPLETE';
    }
    return { state, stopped: false, yielded: false };
}
