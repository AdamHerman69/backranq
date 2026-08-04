import type { VerificationStatus } from '@/lib/training/contracts';

export const EXTRACTION_DECISION_REASONS = [
    'SAVED',
    'FORCED_MOVE',
    'BELOW_COVERAGE_THRESHOLD',
    'BELOW_THRESHOLD_AFTER_CONFIRMATION',
    'ANALYSIS_INCOMPLETE',
    'VERIFICATION_UNSTABLE',
] as const;

export type ExtractionDecisionReason =
    (typeof EXTRACTION_DECISION_REASONS)[number];

export type ExtractionDecisionStatus =
    | 'SAVED'
    | 'NOT_SAVED'
    | 'UNRESOLVED';

export type AdaptiveConfirmationPass = {
    nodes: number;
    bestMoveUci: string | null;
    qualifies: boolean;
    cpLoss: number | null;
    winChanceLoss: number | null;
};

export type AdaptiveConfirmationEvidence = {
    version: 1;
    stable: boolean;
    termination:
        | 'STABLE'
        | 'BELOW_THRESHOLD'
        | 'MAX_BUDGET_UNSTABLE'
        | 'INCOMPLETE';
    passes: AdaptiveConfirmationPass[];
};

export type TrainingDecisionReceipt = {
    ply: number;
    status: ExtractionDecisionStatus;
    reason: ExtractionDecisionReason;
    cpLoss: number | null;
    winChanceLoss: number | null;
    confirmation?: AdaptiveConfirmationEvidence;
    verificationStatus?: VerificationStatus;
    sourceKinds?: Array<'MY_MISTAKE' | 'MISSED_OPPORTUNITY'>;
};

export type TrainingExtractionReceipt = {
    version: 1;
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
    if (reason === 'SAVED') return 'SAVED';
    if (
        reason === 'ANALYSIS_INCOMPLETE' ||
        reason === 'VERIFICATION_UNSTABLE'
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
        value.version !== 1 ||
        typeof value.stable !== 'boolean' ||
        ![
            'STABLE',
            'BELOW_THRESHOLD',
            'MAX_BUDGET_UNSTABLE',
            'INCOMPLETE',
        ].includes(value.termination as string) ||
        !Array.isArray(value.passes) ||
        value.passes.length === 0 ||
        value.passes.length > 8
    ) {
        return false;
    }
    let previousNodes = 0;
    for (const pass of value.passes) {
        if (
            !isRecord(pass) ||
            !integerBetween(pass.nodes, 1, 20_000_000) ||
            (pass.nodes as number) <= previousNodes ||
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
        previousNodes = pass.nodes as number;
    }
    const lastPass = value.passes.at(-1) as Record<string, unknown>;
    return value.termination === 'STABLE'
        ? value.stable && lastPass.qualifies === true
        : value.termination === 'BELOW_THRESHOLD'
          ? value.stable && lastPass.qualifies === false
          : value.stable === false;
}

export function isTrainingExtractionReceipt(
    value: unknown
): value is TrainingExtractionReceipt {
    if (
        !isRecord(value) ||
        value.version !== 1 ||
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
            (reason === 'SAVED' &&
                confirmation !== undefined &&
                (!confirmation.stable ||
                    confirmation.termination !== 'STABLE')) ||
            (reason === 'BELOW_THRESHOLD_AFTER_CONFIRMATION' &&
                (confirmation === undefined ||
                    !confirmation.stable ||
                    confirmation.termination !== 'BELOW_THRESHOLD')) ||
            (decision.verificationStatus !== undefined &&
                !['VERIFIED', 'AMBIGUOUS', 'UNSTABLE', 'INVALID'].includes(
                    decision.verificationStatus as string
                )) ||
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
