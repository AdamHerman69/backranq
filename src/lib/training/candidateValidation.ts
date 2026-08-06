import { Chess } from 'chess.js';
import { isStrictIsoInstant } from '@/lib/api/validation';
import { moveToUci } from '@/lib/chess/utils';
import {
    hashSourcePgn,
    sourcePgnPositionFens,
} from '@/lib/chess/pgn';
import {
    CONTINUATION_SHAPES,
    GRADING_STRATEGIES,
    SOLUTION_SHAPES,
    TRAINING_LESSON_KINDS,
    TRAINING_SOURCE_KINDS,
    VERIFICATION_STATUSES,
    solutionSemanticsHash,
    stableCanonicalStringify,
    type AcceptanceFrontier,
    type GradingPolicyV3,
    type PovScore,
    type SolutionMoveAssessmentInput,
    type SolutionRevisionInput,
    type TrainingMomentCandidate,
} from '@/lib/training/contracts';
import {
    appendAssessmentHistory,
    assessmentPositionKey,
} from '@/lib/training/assessmentIdentity';

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_NODES = 128;
const MAX_TREE_BRANCHES = 16;
const MAX_ASSESSMENTS = 256;
const MAX_BEST_LINE = 64;
const MAX_CANDIDATE_JSON_BYTES = 512_000;
const MAX_POSITION_HISTORY = 256;

const NODE_ROLES = ['USER', 'OPPONENT', 'TERMINAL'] as const;
const EVIDENCE_SOURCES = [
    'ENGINE',
    'TABLEBASE',
    'RULE',
    'NONE',
] as const;
const STOP_REASONS = [
    'CHECKMATE',
    'STALEMATE',
    'INSUFFICIENT_MATERIAL',
    'FIFTY_MOVE',
    'THREEFOLD_REPETITION',
    'MAX_PLIES',
    'MAX_POSITIONS',
    'NO_STABLE_LINE',
] as const;
const TABLEBASE_WDL = ['WIN', 'DRAW', 'LOSS', 'UNKNOWN'] as const;

type ObjectValue = Record<string, unknown>;

type ValidatedTree = {
    root: TreeNode;
    userMovesByPosition: Map<string, Set<string>>;
    bestMovesByPosition: Map<string, Set<string>>;
    assessmentKeysByPosition: Map<string, string>;
};

type TreeNode = {
    fen: string;
    ply: number;
    role: (typeof NODE_ROLES)[number];
    acceptedMovesUci: string[];
    alternativesComplete: boolean;
    selectedMoveUci?: string;
    branches: TreeBranch[];
};

type TreeBranch = {
    moveUci: string;
    best: boolean;
    child: TreeNode;
};

export type TrainingCandidateValidationResult =
    | { ok: true; moments: TrainingMomentCandidate[] }
    | { ok: false; error: string };

function isObject(value: unknown): value is ObjectValue {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function enumValue<T extends string>(
    value: unknown,
    allowed: readonly T[]
): value is T {
    return (
        typeof value === 'string' &&
        (allowed as readonly string[]).includes(value)
    );
}

function finiteBetween(
    value: unknown,
    min: number,
    max: number
): value is number {
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max
    );
}

function safeIntegerBetween(
    value: unknown,
    min: number,
    max: number
): value is number {
    return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= min &&
        value <= max
    );
}

function boundedString(
    value: unknown,
    max: number,
    nonEmpty = true
): value is string {
    return (
        typeof value === 'string' &&
        value.length <= max &&
        (!nonEmpty || value.trim().length > 0)
    );
}

function boundedJson(value: unknown, maxBytes: number): boolean {
    try {
        const serialized = JSON.stringify(value);
        return (
            typeof serialized === 'string' &&
            Buffer.byteLength(serialized, 'utf8') <= maxBytes
        );
    } catch {
        return false;
    }
}

function boundedJsonGraph(
    value: unknown,
    limits: {
        maxDepth?: number;
        maxNodes?: number;
        maxArrayLength?: number;
    } = {}
): boolean {
    const maxDepth = limits.maxDepth ?? 16;
    const maxNodes = limits.maxNodes ?? 4_096;
    const maxArrayLength = limits.maxArrayLength ?? 512;
    const pending: Array<{ value: unknown; depth: number }> = [
        { value, depth: 0 },
    ];
    let nodes = 0;
    while (pending.length > 0) {
        const current = pending.pop()!;
        nodes += 1;
        if (nodes > maxNodes || current.depth > maxDepth) return false;
        if (
            current.value == null ||
            typeof current.value === 'boolean' ||
            typeof current.value === 'number'
        ) {
            if (
                typeof current.value === 'number' &&
                !Number.isFinite(current.value)
            ) {
                return false;
            }
            continue;
        }
        if (typeof current.value === 'string') {
            if (current.value.length > 32_768) return false;
            continue;
        }
        if (Array.isArray(current.value)) {
            if (current.value.length > maxArrayLength) return false;
            for (const item of current.value) {
                pending.push({
                    value: item,
                    depth: current.depth + 1,
                });
            }
            continue;
        }
        if (!isObject(current.value)) return false;
        const entries = Object.entries(current.value);
        if (entries.length > 256) return false;
        for (const [key, item] of entries) {
            if (key.length > 128 || item === undefined) return false;
            pending.push({
                value: item,
                depth: current.depth + 1,
            });
        }
    }
    return true;
}

function normalizedUci(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return UCI_RE.test(normalized) && value === normalized
        ? normalized
        : null;
}

function uniqueUciArray(
    value: unknown,
    max: number,
    allowEmpty: boolean
): string[] | null {
    if (
        !Array.isArray(value) ||
        value.length > max ||
        (!allowEmpty && value.length === 0)
    ) {
        return null;
    }
    const moves: string[] = [];
    for (const item of value) {
        const move = normalizedUci(item);
        if (!move || moves.includes(move)) return null;
        moves.push(move);
    }
    return moves;
}

function uciArray(
    value: unknown,
    max: number,
    allowEmpty: boolean
): string[] | null {
    if (
        !Array.isArray(value) ||
        value.length > max ||
        (!allowEmpty && value.length === 0)
    ) {
        return null;
    }
    const moves: string[] = [];
    for (const item of value) {
        const move = normalizedUci(item);
        if (!move) return null;
        moves.push(move);
    }
    return moves;
}

function validFen(value: unknown): value is string {
    if (!boundedString(value, 128)) return false;
    try {
        new Chess(value);
        return true;
    } catch {
        return false;
    }
}

function applyUci(fen: string, moveUci: string): string | null {
    try {
        const chess = new Chess(fen);
        const move = chess.move({
            from: moveUci.slice(0, 2),
            to: moveUci.slice(2, 4),
            promotion: moveUci.slice(4, 5) || undefined,
        });
        return move ? chess.fen() : null;
    } catch {
        return null;
    }
}

function isPovScore(value: unknown): value is PovScore {
    if (!isObject(value)) return false;
    if (value.kind === 'cp') {
        return (
            value.pov === 'WHITE' &&
            finiteBetween(value.cp, -100_000, 100_000)
        );
    }
    if (value.kind === 'mate') {
        return (
            safeIntegerBetween(value.plies, 0, 4_096) &&
            (value.winner === 'WHITE' || value.winner === 'BLACK')
        );
    }
    return (
        value.kind === 'tablebase' &&
        value.pov === 'WHITE' &&
        enumValue(value.wdl, TABLEBASE_WDL.slice(0, 3)) &&
        (value.dtz === undefined ||
            safeIntegerBetween(value.dtz, -100_000, 100_000))
    );
}

function isRawEngineScore(value: unknown): boolean {
    return (
        value === null ||
        (isObject(value) &&
            (value.type === 'cp' || value.type === 'mate') &&
            finiteBetween(value.value, -100_000, 100_000) &&
            (value.type !== 'mate' ||
                Number.isSafeInteger(value.value)))
    );
}

function isWdl(value: unknown): boolean {
    if (!isObject(value)) return false;
    if (
        !safeIntegerBetween(value.win, 0, 1_000) ||
        !safeIntegerBetween(value.draw, 0, 1_000) ||
        !safeIntegerBetween(value.loss, 0, 1_000)
    ) {
        return false;
    }
    return value.win + value.draw + value.loss === 1_000;
}

function isBranchEvaluation(value: unknown): boolean {
    if (!isObject(value)) return false;
    if (value.source === 'ENGINE') {
        return (
            isRawEngineScore(value.score) &&
            (value.wdl === undefined || isWdl(value.wdl)) &&
            (value.depth === undefined ||
                safeIntegerBetween(value.depth, 0, 256)) &&
            (value.nodes === undefined ||
                safeIntegerBetween(value.nodes, 0, 2_000_000_000))
        );
    }
    if (value.source === 'RULE') {
        return (
            value.outcome === 'DRAW' &&
            value.reason === 'THREEFOLD_REPETITION'
        );
    }
    return (
        value.source === 'TABLEBASE' &&
        enumValue(value.wdl, TABLEBASE_WDL) &&
        boundedString(value.categoryAfterMove, 64) &&
        (value.dtz === undefined ||
            safeIntegerBetween(value.dtz, -100_000, 100_000)) &&
        (value.preciseDtz === undefined ||
            safeIntegerBetween(value.preciseDtz, -100_000, 100_000))
    );
}

function assessmentPositionId(
    position: { fen: string; decisionIndex: number }
): string {
    return `${position.decisionIndex}\u0000${position.fen}`;
}

function validateSolutionTree(
    value: unknown,
    rootFen: string,
    rootPositionHistory: string[]
): ValidatedTree | null {
    if (!isObject(value) || !boundedJson(value, 256_000)) return null;
    let nodeCount = 0;
    const userMovesByPosition = new Map<string, Set<string>>();
    const bestMovesByPosition = new Map<string, Set<string>>();
    const assessmentKeysByPosition = new Map<string, string>();

    const visit = (
        raw: unknown,
        expectedFen: string,
        expectedPly: number,
        depth: number,
        positionHistory: string[]
    ): TreeNode | null => {
        if (
            !isObject(raw) ||
            depth > MAX_TREE_DEPTH ||
            ++nodeCount > MAX_TREE_NODES ||
            !validFen(raw.fen) ||
            raw.fen !== expectedFen ||
            raw.ply !== expectedPly ||
            !enumValue(raw.role, NODE_ROLES) ||
            !enumValue(raw.evidenceSource, EVIDENCE_SOURCES) ||
            typeof raw.alternativesComplete !== 'boolean'
        ) {
            return null;
        }
        const acceptedMoves = uniqueUciArray(
            raw.acceptedMovesUci,
            MAX_TREE_BRANCHES,
            raw.role !== 'USER'
        );
        const selectedMove =
            raw.selectedMoveUci === undefined
                ? undefined
                : normalizedUci(raw.selectedMoveUci);
        if (
            !acceptedMoves ||
            (raw.selectedMoveUci !== undefined && !selectedMove) ||
            (raw.stopReason !== undefined &&
                !enumValue(raw.stopReason, STOP_REASONS)) ||
            (raw.tablebase !== undefined &&
                (!isObject(raw.tablebase) ||
                    !boundedJson(raw.tablebase, 64_000)))
        ) {
            return null;
        }
        if (!Array.isArray(raw.branches)) return null;
        if (raw.branches.length > MAX_TREE_BRANCHES) return null;
        if (
            (raw.role === 'USER' && expectedPly % 2 !== 0) ||
            (raw.role === 'OPPONENT' && expectedPly % 2 !== 1)
        ) {
            return null;
        }
        if (
            raw.role === 'TERMINAL' &&
            (raw.branches.length !== 0 ||
                acceptedMoves.length !== 0 ||
                selectedMove !== undefined)
        ) {
            return null;
        }

        const branches: TreeBranch[] = [];
        const branchMoves = new Set<string>();
        for (const rawBranch of raw.branches) {
            if (
                !isObject(rawBranch) ||
                typeof rawBranch.best !== 'boolean' ||
                !isBranchEvaluation(rawBranch.evaluation)
            ) {
                return null;
            }
            const moveUci = normalizedUci(rawBranch.moveUci);
            if (!moveUci || branchMoves.has(moveUci)) return null;
            const childFen = applyUci(raw.fen, moveUci);
            if (!childFen) return null;
            const child = visit(
                rawBranch.child,
                childFen,
                expectedPly + 1,
                depth + 1,
                appendAssessmentHistory(
                    positionHistory,
                    raw.fen
                )
            );
            if (!child) return null;
            branchMoves.add(moveUci);
            branches.push({
                moveUci,
                best: rawBranch.best,
                child,
            });
        }

        const bestBranches = branches.filter((branch) => branch.best);
        if (
            branches.length > 0 &&
            (bestBranches.length !== 1 ||
                (selectedMove !== undefined &&
                    selectedMove !== bestBranches[0]!.moveUci))
        ) {
            return null;
        }
        if (raw.role === 'USER') {
            if (
                branches.length > 0 &&
                (acceptedMoves.length !== branches.length ||
                    acceptedMoves.some(
                        (move) => !branchMoves.has(move)
                    ))
            ) {
                return null;
            }
            const id = assessmentPositionId({
                fen: raw.fen,
                decisionIndex: Math.floor(expectedPly / 2),
            });
            userMovesByPosition.set(
                id,
                new Set(
                    branches.length > 0
                        ? branches.map((branch) => branch.moveUci)
                        : acceptedMoves
                )
            );
            assessmentKeysByPosition.set(
                id,
                assessmentPositionKey(
                    raw.fen,
                    positionHistory
                )
            );
            if (branches.length > 0) {
                bestMovesByPosition.set(
                    id,
                    new Set(
                        branches
                            .filter((branch) => branch.best)
                            .map((branch) => branch.moveUci)
                    )
                );
            }
        }
        if (
            raw.role === 'OPPONENT' &&
            (acceptedMoves.length !== 0 ||
                (branches.length > 0 &&
                    (!selectedMove ||
                        !branchMoves.has(selectedMove))) ||
                (branches.length === 0 &&
                    selectedMove !== undefined))
        ) {
            return null;
        }

        return {
            fen: raw.fen,
            ply: expectedPly,
            role: raw.role,
            acceptedMovesUci: acceptedMoves,
            alternativesComplete: raw.alternativesComplete,
            ...(selectedMove ? { selectedMoveUci: selectedMove } : {}),
            branches,
        };
    };

    const root = visit(
        value,
        rootFen,
        0,
        0,
        rootPositionHistory
    );
    return root?.role === 'USER'
        ? {
              root,
              userMovesByPosition,
              bestMovesByPosition,
              assessmentKeysByPosition,
          }
        : null;
}

function validateAssessment(
    value: unknown,
    tree: ValidatedTree
): SolutionMoveAssessmentInput | null {
    if (
        !isObject(value) ||
        !boundedString(value.positionKey, 256) ||
        !safeIntegerBetween(value.decisionIndex, 0, 16) ||
        !validFen(value.fen) ||
        value.positionKey !==
            tree.assessmentKeysByPosition.get(
                assessmentPositionId({
                    fen: value.fen,
                    decisionIndex: value.decisionIndex,
                })
            )
    ) {
        return null;
    }
    const moveUci = normalizedUci(value.moveUci);
    const positionId = assessmentPositionId({
        fen: value.fen,
        decisionIndex: value.decisionIndex,
    });
    const allowedMoves = tree.userMovesByPosition.get(positionId);
    if (
        !moveUci ||
        !applyUci(value.fen, moveUci) ||
        !allowedMoves?.has(moveUci) ||
        (value.source !== 'PRECOMPUTED' &&
            value.source !== 'TABLEBASE') ||
        (value.grade !== 'BEST' &&
            value.grade !== 'STRONG' &&
            value.grade !== 'GOOD') ||
        (value.scoreAfter !== null && !isPovScore(value.scoreAfter)) ||
        (value.source === 'TABLEBASE' &&
            (!isObject(value.scoreAfter) ||
                value.scoreAfter.kind !== 'tablebase')) ||
        !boundedJsonGraph(value.evidence) ||
        !boundedJson(value.evidence, 32_000)
    ) {
        return null;
    }
    if (
        isObject(value.evidence) &&
        ((value.evidence.bestGapCp !== undefined &&
            value.evidence.bestGapCp !== null &&
            !finiteBetween(
                value.evidence.bestGapCp,
                0,
                200_000
            )) ||
            (value.evidence.bestGapWinChance !== undefined &&
                value.evidence.bestGapWinChance !== null &&
                !finiteBetween(
                    value.evidence.bestGapWinChance,
                    0,
                    1
                )) ||
            (value.evidence.recoveredCp !== undefined &&
                value.evidence.recoveredCp !== null &&
                !finiteBetween(
                    value.evidence.recoveredCp,
                    0,
                    200_000
                )) ||
            (value.evidence.recoveredWinChance !== undefined &&
                value.evidence.recoveredWinChance !== null &&
                !finiteBetween(
                    value.evidence.recoveredWinChance,
                    0,
                    1
                )) ||
            (value.evidence.preservesOutcome !== undefined &&
                value.evidence.preservesOutcome !== null &&
                typeof value.evidence.preservesOutcome !==
                    'boolean'))
    ) {
        return null;
    }
    return value as unknown as SolutionMoveAssessmentInput;
}

function validateGradingPolicy(
    value: unknown
): value is GradingPolicyV3 {
    if (
        !isObject(value) ||
        value.version !== 3 ||
        value.pov !== 'TRAINING_SIDE' ||
        value.unknownMove !== 'REJECT_OUTSIDE_ACCEPTED_SET' ||
        value.matePolicy !== 'EXACT' ||
        value.tablebasePolicy !== 'EXACT' ||
        !isObject(value.best) ||
        !isObject(value.strong) ||
        !isObject(value.success) ||
        !isObject(value.improvement)
    ) {
        return false;
    }
    if (
        !finiteBetween(value.best.maxCpLoss, 0, 10_000) ||
        !finiteBetween(value.best.maxWinChanceLoss, 0, 1) ||
        !finiteBetween(value.strong.maxCpLoss, 0, 10_000) ||
        !finiteBetween(value.strong.maxWinChanceLoss, 0, 1) ||
        !finiteBetween(value.success.maxCpLoss, 0, 10_000) ||
        !finiteBetween(value.success.maxWinChanceLoss, 0, 1) ||
        typeof value.success.preserveOutcome !== 'boolean' ||
        !finiteBetween(value.improvement.minRecoveredCp, 0, 10_000) ||
        !finiteBetween(
            value.improvement.minRecoveredWinChance,
            0,
            1
        )
    ) {
        return false;
    }
    return (
        value.strong.maxCpLoss >= value.best.maxCpLoss &&
        value.strong.maxWinChanceLoss >=
            value.best.maxWinChanceLoss &&
        value.success.maxCpLoss >= value.strong.maxCpLoss &&
        value.success.maxWinChanceLoss >=
            value.strong.maxWinChanceLoss
    );
}

function validateAcceptanceFrontier(
    value: unknown,
    acceptedMovesUci: string[],
    bestMoveUci: string
): AcceptanceFrontier | null {
    if (
        !isObject(value) ||
        value.version !== 1 ||
        (value.status !== 'STABLE' &&
            value.status !== 'OPEN' &&
            value.status !== 'UNSTABLE') ||
        !finiteBetween(value.targetCutoffCp, 0, 10_000) ||
        (value.effectiveCutoffCp !== null &&
            !finiteBetween(value.effectiveCutoffCp, 0, 10_000)) ||
        (value.boundaryGapCp !== null &&
            !finiteBetween(value.boundaryGapCp, 0, 10_000)) ||
        (value.firstRejectedMoveUci !== null &&
            !normalizedUci(value.firstRejectedMoveUci)) ||
        !Array.isArray(value.moves)
    ) {
        return null;
    }
    const moves = value.moves.map((rawMove) => {
        if (!isObject(rawMove)) return null;
        const moveUci = normalizedUci(rawMove.moveUci);
        if (
            !moveUci ||
            (rawMove.tier !== 'BEST' &&
                rawMove.tier !== 'STRONG' &&
                rawMove.tier !== 'GOOD')
        ) {
            return null;
        }
        return { moveUci, tier: rawMove.tier };
    });
    if (
        moves.some((move) => move == null) ||
        moves.length !== acceptedMovesUci.length ||
        moves.some(
            (move, index) =>
                move?.moveUci !== acceptedMovesUci[index]
        ) ||
        moves[0]?.moveUci !== bestMoveUci ||
        moves[0]?.tier !== 'BEST'
    ) {
        return null;
    }
    return value as AcceptanceFrontier;
}

function validateBestLine(
    bestLine: unknown,
    solution: {
        bestMoveUci: string;
        continuationShape: string;
    },
    tree: ValidatedTree
): string[] | null {
    const line = uciArray(bestLine, MAX_BEST_LINE, false);
    if (
        !line ||
        line[0] !== solution.bestMoveUci ||
        (solution.continuationShape === 'SINGLE_DECISION' &&
            line.length !== 1) ||
        (solution.continuationShape === 'CONDITIONAL_LINE' &&
            line.length < 2)
    ) {
        return null;
    }
    let chess: Chess;
    try {
        chess = new Chess(tree.root.fen);
    } catch {
        return null;
    }
    let node: TreeNode | null = tree.root;
    for (const moveUci of line) {
        let move;
        try {
            move = chess.move({
                from: moveUci.slice(0, 2),
                to: moveUci.slice(2, 4),
                promotion: moveUci.slice(4, 5) || undefined,
            });
        } catch {
            return null;
        }
        if (!move) return null;
        if (node && node.branches.length > 0) {
            const branch: TreeBranch | undefined =
                node.branches.find(
                (candidate) => candidate.moveUci === moveUci
            );
            if (
                !branch ||
                (node.role === 'USER' && !branch.best) ||
                (node.role === 'OPPONENT' &&
                    node.selectedMoveUci !== moveUci)
            ) {
                return null;
            }
            node = branch.child;
        } else {
            node = null;
        }
    }
    return line;
}

function validateSolution(
    value: unknown,
    rootFen: string,
    rootPositionHistory: string[]
): SolutionRevisionInput | null {
    if (
        !isObject(value) ||
        !HASH_RE.test(String(value.solutionHash)) ||
        !enumValue(value.verificationStatus, VERIFICATION_STATUSES) ||
        !enumValue(value.solutionShape, SOLUTION_SHAPES) ||
        !enumValue(value.gradingStrategy, GRADING_STRATEGIES) ||
        !enumValue(value.continuationShape, CONTINUATION_SHAPES) ||
        typeof value.trainable !== 'boolean'
    ) {
        return null;
    }
    const bestMoveUci = normalizedUci(value.bestMoveUci);
    const acceptedMovesUci = uniqueUciArray(
        value.acceptedMovesUci,
        16,
        false
    );
    const tree = validateSolutionTree(
        value.solutionTree,
        rootFen,
        rootPositionHistory
    );
    const acceptanceFrontier =
        acceptedMovesUci && bestMoveUci
            ? validateAcceptanceFrontier(
                  value.acceptanceFrontier,
                  acceptedMovesUci,
                  bestMoveUci
              )
            : null;
    if (
        !bestMoveUci ||
        !acceptedMovesUci ||
        !acceptedMovesUci.includes(bestMoveUci) ||
        !acceptanceFrontier ||
        !tree ||
        tree.root.acceptedMovesUci.length !==
            acceptedMovesUci.length ||
        tree.root.acceptedMovesUci.some(
            (move) => !acceptedMovesUci.includes(move)
        ) ||
        !validateBestLine(
            value.bestLineUci,
            {
                bestMoveUci,
                continuationShape: value.continuationShape,
            },
            tree
        ) ||
        (value.scoreAtStart !== null &&
            !isPovScore(value.scoreAtStart)) ||
        (value.playedMoveScore !== null &&
            !isPovScore(value.playedMoveScore)) ||
        !validateGradingPolicy(value.gradingPolicy) ||
        !boundedString(value.generatorVersion, 128) ||
        typeof value.configHash !== 'string' ||
        !HASH_RE.test(value.configHash) ||
        !boundedJsonGraph(value.evidence, {
            maxDepth: MAX_TREE_DEPTH * 4,
            maxNodes: 8_192,
        }) ||
        !boundedJson(value.evidence, 128_000)
    ) {
        return null;
    }
    if (
        (value.trainable &&
            (value.verificationStatus !== 'VERIFIED' ||
                acceptanceFrontier.status !== 'STABLE')) ||
        (value.trainable && value.scoreAtStart === null)
    ) {
        return null;
    }
    if (
        (acceptanceFrontier.status === 'STABLE') !==
        tree.root.alternativesComplete
    ) {
        return null;
    }
    if (
        !isObject(value.targetOutcome) ||
        value.targetOutcome.kind !== 'MAXIMIZE_WINNING_CHANCE' ||
        (value.targetOutcome.score !== null &&
            !isPovScore(value.targetOutcome.score)) ||
        stableCanonicalStringify(value.targetOutcome.score) !==
            stableCanonicalStringify(value.scoreAtStart)
    ) {
        return null;
    }
    if (
        (value.solutionShape === 'UNIQUE' &&
            acceptedMovesUci.length !== 1) ||
        (value.solutionShape === 'MULTIPLE' &&
            acceptedMovesUci.length < 2) ||
        (acceptanceFrontier.status === 'STABLE' &&
            value.solutionShape === 'OPEN') ||
        (acceptanceFrontier.status !== 'STABLE' &&
            value.solutionShape !== 'OPEN')
    ) {
        return null;
    }
    if (
        !Array.isArray(value.moveAssessments) ||
        value.moveAssessments.length === 0 ||
        value.moveAssessments.length > MAX_ASSESSMENTS
    ) {
        return null;
    }
    const assessments: SolutionMoveAssessmentInput[] = [];
    const assessmentKeys = new Set<string>();
    for (const rawAssessment of value.moveAssessments) {
        const assessment = validateAssessment(rawAssessment, tree);
        if (!assessment) return null;
        const key = `${assessment.decisionIndex}\u0000${assessment.positionKey}\u0000${assessment.moveUci}`;
        if (assessmentKeys.has(key)) return null;
        assessmentKeys.add(key);
        assessments.push(assessment);
    }
    const rootPosition = assessmentPositionId({
        fen: rootFen,
        decisionIndex: 0,
    });
    for (const move of acceptedMovesUci) {
        const assessment = assessments.find(
            (candidate) =>
                assessmentPositionId(candidate) === rootPosition &&
                candidate.moveUci === move
        );
        if (
            !assessment ||
            assessment.grade !==
                acceptanceFrontier.moves.find(
                    (frontierMove) =>
                        frontierMove.moveUci === move
                )?.tier
        ) {
            return null;
        }
    }
    for (const [position, moves] of tree.userMovesByPosition) {
        const bestMoves = tree.bestMovesByPosition.get(position);
        for (const move of moves) {
            const assessment = assessments.find(
                (candidate) =>
                    assessmentPositionId(candidate) === position &&
                    candidate.moveUci === move
            );
            if (
                !assessment ||
                (bestMoves &&
                    (bestMoves.has(move)
                        ? assessment.grade !== 'BEST'
                        : assessment.grade !== 'BEST' &&
                          assessment.grade !== 'STRONG' &&
                          assessment.grade !== 'GOOD'))
            ) {
                return null;
            }
        }
    }
    const solution = value as unknown as SolutionRevisionInput;
    return solutionSemanticsHash(solution) === solution.solutionHash
        ? solution
        : null;
}

function validateCandidate(value: unknown): TrainingMomentCandidate | null {
    if (
        !isObject(value) ||
        !boundedJson(value, MAX_CANDIDATE_JSON_BYTES) ||
        !boundedJsonGraph(value, {
            maxDepth: MAX_TREE_DEPTH * 4,
            maxNodes: 8_192,
        }) ||
        !isObject(value.originalDecision) ||
        !boundedString(value.sourceGameId, 512) ||
        (value.sourceProvider !== 'lichess' &&
            value.sourceProvider !== 'chesscom') ||
        !isStrictIsoInstant(value.sourcePlayedAt) ||
        typeof value.sourcePgnHash !== 'string' ||
        !HASH_RE.test(value.sourcePgnHash) ||
        !safeIntegerBetween(value.decisionPly, 0, 2_047) ||
        !validFen(value.fen) ||
        !Array.isArray(value.positionHistory) ||
        value.positionHistory.length > MAX_POSITION_HISTORY ||
        !value.positionHistory.every(validFen) ||
        (value.sideToMove !== 'w' && value.sideToMove !== 'b') ||
        value.sideToMove !== value.fen.split(/\s+/)[1]
    ) {
        return null;
    }
    const originalMoveUci = normalizedUci(value.originalMoveUci);
    if (!originalMoveUci || !applyUci(value.fen, originalMoveUci)) {
        return null;
    }
    if (
        !Array.isArray(value.sourceKinds) ||
        value.sourceKinds.length === 0 ||
        value.sourceKinds.length > TRAINING_SOURCE_KINDS.length ||
        new Set(value.sourceKinds).size !== value.sourceKinds.length ||
        !value.sourceKinds.every((kind) =>
            enumValue(kind, TRAINING_SOURCE_KINDS)
        ) ||
        !Array.isArray(value.lessonKinds) ||
        value.lessonKinds.length === 0 ||
        value.lessonKinds.length > TRAINING_LESSON_KINDS.length ||
        new Set(value.lessonKinds).size !== value.lessonKinds.length ||
        !value.lessonKinds.every((kind) =>
            enumValue(kind, TRAINING_LESSON_KINDS)
        ) ||
        !Array.isArray(value.themes) ||
        value.themes.length > 64 ||
        new Set(value.themes).size !== value.themes.length ||
        !value.themes.every((theme) => boundedString(theme, 64)) ||
        !isPovScore(value.originalDecision.scoreBefore) ||
        !isPovScore(value.originalDecision.scoreAfter) ||
        (value.originalDecision.cpLoss !== undefined &&
            !finiteBetween(
                value.originalDecision.cpLoss,
                0,
                200_000
            )) ||
        (value.originalDecision.winChanceLoss !== undefined &&
            !finiteBetween(
                value.originalDecision.winChanceLoss,
                0,
                1
            )) ||
        (value.confidence !== undefined &&
            !finiteBetween(value.confidence, 0, 1)) ||
        (value.phase !== undefined &&
            value.phase !== 'OPENING' &&
            value.phase !== 'MIDDLEGAME' &&
            value.phase !== 'ENDGAME')
    ) {
        return null;
    }
    const solution = validateSolution(
        value.solution,
        value.fen,
        value.positionHistory
    );
    if (
        !solution ||
        stableCanonicalStringify(solution.playedMoveScore) !==
            stableCanonicalStringify(
                value.originalDecision.scoreAfter
            )
    ) {
        return null;
    }
    return value as unknown as TrainingMomentCandidate;
}

export function validateTrainingMomentCandidates(
    value: unknown,
    maxItems = 2_048
): TrainingCandidateValidationResult {
    if (!Array.isArray(value) || value.length > maxItems) {
        return { ok: false, error: 'Invalid training moments' };
    }
    const moments: TrainingMomentCandidate[] = [];
    const canonicalDecisions = new Set<string>();
    for (const candidate of value) {
        const validated = validateCandidate(candidate);
        if (!validated) {
            return { ok: false, error: 'Invalid training moments' };
        }
        const canonicalDecision = [
            validated.sourceGameId,
            validated.sourcePgnHash,
            validated.decisionPly,
        ].join('\u0000');
        if (canonicalDecisions.has(canonicalDecision)) {
            return { ok: false, error: 'Invalid training moments' };
        }
        canonicalDecisions.add(canonicalDecision);
        moments.push(validated);
    }
    return { ok: true, moments };
}

export function trainingMomentCandidatesMatchSource(args: {
    moments: TrainingMomentCandidate[];
    gameId: string;
    provider: 'lichess' | 'chesscom';
    playedAt: Date;
    pgn: string;
    configHash: string;
}): boolean {
    const fens = sourcePgnPositionFens(args.pgn);
    if (!fens) return false;
    const chess = new Chess();
    try {
        chess.loadPgn(args.pgn, { strict: false });
    } catch {
        return false;
    }
    const moves = chess.history({ verbose: true });
    const pgnHash = hashSourcePgn(args.pgn);
    return args.moments.every((moment) => {
        const sourceMove = moves[moment.decisionPly];
        const sourceFen = fens[moment.decisionPly];
        const expectedHistory = fens.slice(
            Math.max(
                0,
                moment.decisionPly - MAX_POSITION_HISTORY
            ),
            moment.decisionPly
        );
        return (
            !!sourceMove &&
            !!sourceFen &&
            moment.sourceGameId === args.gameId &&
            moment.sourceProvider === args.provider &&
            Date.parse(moment.sourcePlayedAt) ===
                args.playedAt.getTime() &&
            moment.sourcePgnHash === pgnHash &&
            moment.fen === sourceFen &&
            stableCanonicalStringify(
                moment.positionHistory
            ) === stableCanonicalStringify(expectedHistory) &&
            moment.sideToMove === sourceFen.split(/\s+/)[1] &&
            moment.originalMoveUci ===
                moveToUci(sourceMove).toLowerCase() &&
            moment.solution.configHash === args.configHash
        );
    });
}
