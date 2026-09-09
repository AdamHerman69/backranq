import type { T2PointDecision } from './t2Policy';
import { isExtractionWork, type ExtractionWork } from './extractionWork';

export const EXTRACTION_DECISION_REASONS = [
    'MISTAKE_CONFIRMED',
    'FORCED_MOVE',
    'BELOW_CANDIDATE_SIGNAL',
    'ORIGINAL_MOVE_QUALITY_CONFIRMED',
    'ENGINE_EVIDENCE_INVALID',
    'MISTAKE_COMPARISON_UNRESOLVED',
    'SOURCE_INVALID',
    'NO_MEANINGFUL_SELECTION_SIGNAL',
] as const;

export type ExtractionDecisionReason =
    (typeof EXTRACTION_DECISION_REASONS)[number];

export type ExtractionDecisionStatus =
    | 'SAVED'
    | 'NOT_SAVED'
    | 'UNRESOLVED';

export type AdaptiveConfirmationPass = {
    /** One actual request in execution order; dependency budgets need not increase. */
    nodes: number;
    purpose: 'MISSING_REFERENCE' | 'REFERENCE_DRIFT' | 'VERIFY_REFERENCE' | 'MISSING_MOVE';
    searchId: string | null;
    outcome: 'RETURNED' | 'UNATTRIBUTED';
    bestMoveUci: string | null;
    qualifies: boolean;
    cpLoss: number | null;
    winChanceLoss: number | null;
};

export type AdaptiveConfirmationEvidence = {
    version: 2;
    stable: boolean;
    termination:
        | 'STABLE'
        | 'BELOW_THRESHOLD'
        | 'MAX_BUDGET_UNSTABLE'
        | 'INCOMPLETE';
    passes: AdaptiveConfirmationPass[];
};

export type TrainingDecisionReceipt = {
    /** Selection allocation and point estimate, independent of answer support. */
    t2Decision?: T2PointDecision;
    ply: number;
    status: ExtractionDecisionStatus;
    reason: ExtractionDecisionReason;
    cpLoss: number | null;
    winChanceLoss: number | null;
    confirmation?: AdaptiveConfirmationEvidence;
    sourceKinds?: Array<'MY_MISTAKE' | 'MISSED_OPPORTUNITY'>;
};

export type TrainingExtractionReceipt = {
    version: 2;
    engineWork: ExtractionWork;
    trainingSide: 'WHITE' | 'BLACK';
    thresholds: {
        minWinChanceLoss: number;
        fallbackMinCpLoss: number;
    };
    budgets: {
        scanNodes: number | null;
        confirmationBaseNodes: number | null;
        confirmationMaxNodes: number | null;
        multiPvStart: number;
        multiPvMax: number;
    };
    summary: {
        userDecisions: number;
        savedPositions: number;
        unresolvedDecisions: number;
        reasons: Record<ExtractionDecisionReason, number>;
    };
    decisions: TrainingDecisionReceipt[];
};

export function emptyExtractionReasonCounts(): Record<
    ExtractionDecisionReason,
    number
> {
    return Object.fromEntries(
        EXTRACTION_DECISION_REASONS.map((reason) => [reason, 0])
    ) as Record<ExtractionDecisionReason, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function integerBetween(
    value: unknown,
    min: number,
    max: number
): value is number {
    return (
        Number.isSafeInteger(value) &&
        (value as number) >= min &&
        (value as number) <= max
    );
}

function nullableIntegerBetween(
    value: unknown,
    min: number,
    max: number
): boolean {
    return value === null || integerBetween(value, min, max);
}

function expectedStatus(
    reason: ExtractionDecisionReason
): ExtractionDecisionStatus {
    if (reason === 'MISTAKE_CONFIRMED') return 'SAVED';
    if (
        reason === 'ENGINE_EVIDENCE_INVALID' ||
        reason === 'MISTAKE_COMPARISON_UNRESOLVED'
    ) {
        return 'UNRESOLVED';
    }
    return 'NOT_SAVED';
}

function isConfirmationEvidence(
    value: unknown
): value is AdaptiveConfirmationEvidence {
    if (
        !isRecord(value) ||
        value.version !== 2 ||
        typeof value.stable !== 'boolean' ||
        ![
            'STABLE',
            'BELOW_THRESHOLD',
            'MAX_BUDGET_UNSTABLE',
            'INCOMPLETE',
        ].includes(value.termination as string) ||
        !Array.isArray(value.passes) ||
        value.passes.length > 256
    ) {
        return false;
    }
    const searchIds = new Set<string>();
    for (const pass of value.passes) {
        if (
            !isRecord(pass) ||
            !integerBetween(pass.nodes, 1, 20_000_000) ||
            !['MISSING_REFERENCE', 'REFERENCE_DRIFT', 'VERIFY_REFERENCE', 'MISSING_MOVE'].includes(pass.purpose as string) ||
            !['RETURNED', 'UNATTRIBUTED'].includes(pass.outcome as string) ||
            (pass.outcome === 'UNATTRIBUTED' ? pass.searchId !== null
                : typeof pass.searchId !== 'string' || pass.searchId.length === 0 || pass.searchId.length > 1024 || searchIds.has(pass.searchId)) ||
            (pass.bestMoveUci !== null &&
                (typeof pass.bestMoveUci !== 'string' ||
                    !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(
                        pass.bestMoveUci
                    ))) ||
            typeof pass.qualifies !== 'boolean' ||
            (pass.cpLoss !== null &&
                !finiteBetween(pass.cpLoss, 0, 200_000)) ||
            (pass.winChanceLoss !== null &&
                !finiteBetween(pass.winChanceLoss, 0, 1))
        ) {
            return false;
        }
        if (typeof pass.searchId === 'string') searchIds.add(pass.searchId);
    }
    const lastPass = value.passes.at(-1) as Record<string, unknown> | undefined;
    return value.termination === 'STABLE'
        ? value.stable && (lastPass == null || lastPass.qualifies === true)
        : value.termination === 'BELOW_THRESHOLD'
          ? value.stable && (lastPass == null || lastPass.qualifies === false)
          : value.stable === false;
}

export function isTrainingExtractionReceipt(
    value: unknown
): value is TrainingExtractionReceipt {
    if (
        !isRecord(value) ||
        value.version !== 2 ||
        !isExtractionWork(value.engineWork) ||
        (value.trainingSide !== 'WHITE' && value.trainingSide !== 'BLACK') ||
        !isRecord(value.thresholds) ||
        !finiteBetween(value.thresholds.minWinChanceLoss, 0, 1) ||
        !finiteBetween(value.thresholds.fallbackMinCpLoss, 0, 10_000) ||
        !isRecord(value.budgets) ||
        !nullableIntegerBetween(value.budgets.scanNodes, 1, 10_000_000) ||
        !nullableIntegerBetween(
            value.budgets.confirmationBaseNodes,
            1,
            20_000_000
        ) ||
        !nullableIntegerBetween(
            value.budgets.confirmationMaxNodes,
            1,
            20_000_000
        ) ||
        ((value.budgets.confirmationBaseNodes === null) !==
            (value.budgets.confirmationMaxNodes === null)) ||
        (typeof value.budgets.confirmationBaseNodes === 'number' &&
            typeof value.budgets.confirmationMaxNodes === 'number' &&
            value.budgets.confirmationMaxNodes <
                value.budgets.confirmationBaseNodes) ||
        !integerBetween(value.budgets.multiPvStart, 1, 16) ||
        !integerBetween(value.budgets.multiPvMax, 1, 16) ||
        (value.budgets.multiPvMax as number) <
            (value.budgets.multiPvStart as number) ||
        !isRecord(value.summary) ||
        !integerBetween(value.summary.userDecisions, 0, 2_048) ||
        !integerBetween(value.summary.savedPositions, 0, 2_048) ||
        !integerBetween(value.summary.unresolvedDecisions, 0, 2_048) ||
        !isRecord(value.summary.reasons) ||
        !Array.isArray(value.decisions) ||
        value.decisions.length > 2_048 ||
        value.decisions.length !== value.summary.userDecisions
    ) {
        return false;
    }

    const counts = emptyExtractionReasonCounts();
    let saved = 0;
    let unresolved = 0;
    let previousPly = -1;
    for (const decision of value.decisions) {
        if (
            !isRecord(decision) ||
            !integerBetween(decision.ply, 0, 2_047) ||
            (decision.ply as number) <= previousPly ||
            !EXTRACTION_DECISION_REASONS.includes(
                decision.reason as ExtractionDecisionReason
            )
        ) {
            return false;
        }
        const reason = decision.reason as ExtractionDecisionReason;
        const confirmation = decision.confirmation;
        if (
            decision.status !== expectedStatus(reason) ||
            (decision.cpLoss !== null &&
                !finiteBetween(decision.cpLoss, 0, 200_000)) ||
            (decision.winChanceLoss !== null &&
                !finiteBetween(decision.winChanceLoss, 0, 1)) ||
            (confirmation !== undefined &&
                !isConfirmationEvidence(confirmation)) ||
            (reason === 'MISTAKE_CONFIRMED' &&
                confirmation !== undefined &&
                (!confirmation.stable ||
                    confirmation.termination !== 'STABLE')) ||
            (decision.sourceKinds !== undefined &&
                (!Array.isArray(decision.sourceKinds) ||
                    decision.sourceKinds.length > 2 ||
                    decision.sourceKinds.some(
                        (source) =>
                            source !== 'MY_MISTAKE' &&
                            source !== 'MISSED_OPPORTUNITY'
                    )))
        ) {
            return false;
        }
        previousPly = decision.ply as number;
        counts[reason] += 1;
        if (decision.status === 'SAVED') saved += 1;
        if (decision.status === 'UNRESOLVED') unresolved += 1;
    }

    const summary = value.summary as Record<string, unknown>;
    const summaryReasons = summary.reasons as Record<string, unknown>;
    return (
        saved === summary.savedPositions &&
        unresolved === summary.unresolvedDecisions &&
        Object.keys(summaryReasons).length ===
            EXTRACTION_DECISION_REASONS.length &&
        EXTRACTION_DECISION_REASONS.every(
            (reason) =>
                summaryReasons[reason] === counts[reason]
        )
    );
}
