import type { PracticeReferenceReadiness } from '../../src/lib/training/assessmentPolicy';
import type { MoveAssessment } from '../../src/lib/training/practiceContract';

type Verdict = Pick<MoveAssessment, 'quality' | 'qualitySupport'>;
export function comparatorNeedsReferenceRefresh(reference: Verdict | undefined, hasDrift: boolean): boolean {
    return hasDrift || reference?.quality !== 'GOOD' || reference.qualitySupport !== 'SUPPORTED';
}

/** Finite labels are benchmark ground only when their shared reference is supported. */
export function auditComparatorVerdict(args: {
    runtimeQuality: string; assessment: Verdict | undefined; reference: Verdict | undefined;
    hasDrift: boolean; rule: Verdict | undefined;
}) {
    const candidateComparatorQuality = args.assessment?.qualitySupport === 'SUPPORTED' ? args.assessment.quality : 'UNKNOWN';
    const rule = args.rule?.qualitySupport === 'SUPPORTED' && args.rule.quality !== 'UNKNOWN' ? args.rule : undefined;
    const comparatorUnresolvedReason = rule ? null
        : args.reference?.quality !== 'GOOD' || args.reference.qualitySupport !== 'SUPPORTED' ? 'REFERENCE_UNRESOLVED'
        : args.hasDrift ? 'REFERENCE_DRIFT'
        : candidateComparatorQuality === 'UNKNOWN' ? 'MOVE_UNRESOLVED' : null;
    const comparatorQuality = rule?.quality ?? (comparatorUnresolvedReason ? 'UNKNOWN' : candidateComparatorQuality);
    return {
        comparatorQuality, comparatorBasis: rule ? 'RULE' : 'FINITE_ENGINE', comparatorUnresolvedReason,
        candidateComparatorQuality,
        candidateDisagreement: args.runtimeQuality !== 'UNKNOWN' && candidateComparatorQuality !== 'UNKNOWN' && args.runtimeQuality !== candidateComparatorQuality,
        disagreement: args.runtimeQuality !== 'UNKNOWN' && comparatorQuality !== 'UNKNOWN' && args.runtimeQuality !== comparatorQuality,
    };
}

/** A reservation is consumed before dispatch, including failed searches. Cursors
 * are independent: checking a reference cannot consume an answer's ladder. */
export class AuditWorkBudget {
    private readonly cursors = new Map<string, number>();
    private readonly jobs: { kind: 'ROOT' | 'REFERENCE_PROBE' | 'MOVE'; nodes: number; moveUci: string | null }[] = [];
    private requestedNodes = 0;
    private stopReason: string | null = null;
    constructor(private readonly config: {
        root: readonly number[]; probe: readonly number[]; move: readonly number[]; maximumRequestedNodes: number;
    }) {
        if (!Number.isSafeInteger(config.maximumRequestedNodes) || config.maximumRequestedNodes < 1
            || [config.root, config.probe, config.move].some(levels => levels.some((n, i) => !Number.isSafeInteger(n) || n < 1 || i > 0 && n <= levels[i - 1]))) throw new Error('Invalid audit budget');
    }
    take(kind: 'ROOT' | 'REFERENCE_PROBE' | 'MOVE', moveUci?: string) {
        if (kind !== 'ROOT' && !moveUci) throw new Error('A singleton audit job requires a move');
        // Probe budget is global even if the preferred move changes repeatedly.
        const key = kind === 'MOVE' ? `${kind}:${moveUci}` : kind;
        const levels = kind === 'ROOT' ? this.config.root : kind === 'REFERENCE_PROBE' ? this.config.probe : this.config.move;
        const cursor = this.cursors.get(key) ?? 0; const nodes = levels[cursor];
        if (nodes === undefined) { this.stopReason = `${kind}_LADDER_EXHAUSTED`; return null; }
        if (this.requestedNodes + nodes > this.config.maximumRequestedNodes) { this.stopReason = 'NODE_BUDGET_EXHAUSTED'; return null; }
        const job = { kind, nodes, moveUci: kind === 'ROOT' ? null : moveUci! };
        this.cursors.set(key, cursor + 1); this.requestedNodes += nodes; this.jobs.push(job); this.stopReason = null;
        return job;
    }
    takeReference(readiness: PracticeReferenceReadiness | null) {
        if (readiness?.requiredWork === null) return null;
        return this.take(readiness?.requiredWork ?? 'ROOT', readiness?.preferredMoveUci);
    }
    report() { return { maximumRequestedNodes: this.config.maximumRequestedNodes, requestedNodes: this.requestedNodes,
        physicalReservations: this.jobs.length, stopReason: this.stopReason, jobs: this.jobs.map(job => ({ ...job })) }; }
}
