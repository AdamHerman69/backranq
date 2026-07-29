/**
 * Reduce a verifier tree to grading-relevant structure. Volatile engine and
 * tablebase evidence (nodes, depth, DTZ fetch time, etc.) belongs in immutable
 * revision evidence, but must not change otherwise identical solution
 * semantics.
 */
function objectValue(
    value: unknown
): Record<string, unknown> | null {
    return value &&
        typeof value === 'object' &&
        !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function canonicalScore(value: unknown): unknown {
    const score = objectValue(value);
    if (!score) return value ?? null;
    return {
        ...(typeof score.type === 'string'
            ? { type: score.type }
            : {}),
        ...(typeof score.value === 'number'
            ? { value: score.value }
            : {}),
    };
}

function canonicalWdl(value: unknown): unknown {
    if (typeof value === 'string') return value;
    const wdl = objectValue(value);
    if (!wdl) return value ?? null;
    return {
        ...(typeof wdl.win === 'number'
            ? { win: wdl.win }
            : {}),
        ...(typeof wdl.draw === 'number'
            ? { draw: wdl.draw }
            : {}),
        ...(typeof wdl.loss === 'number'
            ? { loss: wdl.loss }
            : {}),
    };
}

function canonicalAssessmentEvaluation(
    value: unknown
): unknown {
    const evaluation = objectValue(value);
    if (!evaluation) return value ?? null;
    return {
        ...(typeof evaluation.source === 'string'
            ? { source: evaluation.source }
            : {}),
        ...(evaluation.score !== undefined
            ? { score: canonicalScore(evaluation.score) }
            : {}),
        ...(evaluation.wdl !== undefined
            ? { wdl: canonicalWdl(evaluation.wdl) }
            : {}),
        ...(typeof evaluation.category === 'string'
            ? { category: evaluation.category }
            : {}),
        ...(typeof evaluation.categoryAfterMove === 'string'
            ? {
                  categoryAfterMove:
                      evaluation.categoryAfterMove,
              }
            : {}),
        ...(typeof evaluation.outcome === 'string'
            ? { outcome: evaluation.outcome }
            : {}),
        ...(typeof evaluation.reason === 'string'
            ? { reason: evaluation.reason }
            : {}),
    };
}

/**
 * Exhaustive grading-consumer evidence. Search cost/provenance fields such as
 * depth, nodes, elapsed time, provider identity and raw matched passes are
 * intentionally excluded from immutable solution identity.
 */
export function canonicalMoveAssessmentEvidence(
    value: unknown
): unknown {
    const evidence = objectValue(value);
    if (!evidence) return {};
    const output: Record<string, unknown> = {};
    for (const key of [
        'bestGapCp',
        'bestGapWinChance',
        'recoveredCp',
        'recoveredWinChance',
        'preservesOutcome',
    ] as const) {
        if (evidence[key] !== undefined) {
            output[key] = evidence[key];
        }
    }
    if (evidence.evaluation !== undefined) {
        output.evaluation = canonicalAssessmentEvaluation(
            evidence.evaluation
        );
    }
    if (evidence.score !== undefined) {
        output.score = canonicalScore(evidence.score);
    }
    if (evidence.wdl !== undefined) {
        output.wdl = canonicalWdl(evidence.wdl);
    }
    for (const key of [
        'category',
        'categoryAfterMove',
        'outcome',
        'ruleTerminal',
    ] as const) {
        if (typeof evidence[key] === 'string') {
            output[key] = evidence[key];
        }
    }
    return output;
}

export function canonicalSolutionTreeSemantics(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const node = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    if (typeof node.fen === 'string') normalized.fen = node.fen;
    if (Number.isSafeInteger(node.ply)) normalized.ply = node.ply;
    if (typeof node.role === 'string') normalized.role = node.role;
    if (Array.isArray(node.acceptedMovesUci)) {
        normalized.acceptedMovesUci = Array.from(
            new Set(
                node.acceptedMovesUci
                    .filter(
                        (move): move is string => typeof move === 'string'
                    )
                    .map((move) => move.trim().toLowerCase())
                    .filter(Boolean)
            )
        ).sort();
    }
    if (typeof node.selectedMoveUci === 'string') {
        normalized.selectedMoveUci = node.selectedMoveUci
            .trim()
            .toLowerCase();
    }
    if (typeof node.alternativesComplete === 'boolean') {
        normalized.alternativesComplete = node.alternativesComplete;
    }
    if (typeof node.stopReason === 'string') {
        normalized.stopReason = node.stopReason;
    }
    if (Array.isArray(node.branches)) {
        normalized.branches = node.branches
            .filter(
                (branch): branch is Record<string, unknown> =>
                    !!branch &&
                    typeof branch === 'object' &&
                    !Array.isArray(branch)
            )
            .map((branch) => ({
                moveUci:
                    typeof branch.moveUci === 'string'
                        ? branch.moveUci.trim().toLowerCase()
                        : '',
                best: branch.best === true,
                child: canonicalSolutionTreeSemantics(branch.child ?? {}),
            }))
            .sort((left, right) => {
                if (left.best !== right.best) return left.best ? -1 : 1;
                return left.moveUci.localeCompare(right.moveUci);
            });
    }
    return normalized;
}
