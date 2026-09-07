import {
    legalMovesUci, type AnswerIndex, type ComparisonFrame, type CoverageGroup,
    type MoveAssessment, type PracticeMomentRevision, type Quality,
} from './practiceContract';

/** This projection takes already validated assessments; parsing validates evidence first. */
export function deriveAnswerIndex(args: {
    contextId: string; frameId: string; legalMovesUci: readonly string[];
    preferredMoveUci: string; assessments: readonly MoveAssessment[]; coverageGroups: readonly CoverageGroup[];
}): AnswerIndex {
    const legal = [...new Set(args.legalMovesUci)].sort();
    if (!legal.includes(args.preferredMoveUci)) throw new Error('Preferred move must be legal');
    const assessments = args.assessments.filter(a => a.contextId === args.contextId && a.frameId === args.frameId);
    const groups = args.coverageGroups.filter(g => g.contextId === args.contextId && g.frameId === args.frameId);
    const classified = new Map<string, Quality>();
    for (const assessment of assessments) {
        if (!legal.includes(assessment.moveUci)) throw new Error('Assessment move outside legal scope');
        if (assessment.qualitySupport !== 'SUPPORTED' || assessment.quality === 'UNKNOWN') continue;
        const existing = classified.get(assessment.moveUci);
        if (existing && existing !== assessment.quality) throw new Error('Conflicting supported individual assessments');
        classified.set(assessment.moveUci, assessment.quality);
    }
    for (const group of groups) for (const move of group.movesUci) {
        if (!legal.includes(move)) throw new Error('Coverage move outside legal scope');
        if (classified.get(move) === 'GOOD') throw new Error('Coverage contradicts supported GOOD');
        classified.set(move, 'BELOW_STANDARD');
    }
    const unresolved = legal.filter(m => !classified.has(m));
    return {
        contextId: args.contextId, frameId: args.frameId, legalMovesUci: legal,
        assessmentIds: assessments.map(a => a.id).sort(), coverageGroupIds: groups.map(g => g.id).sort(),
        preferredMoveUci: args.preferredMoveUci, unresolvedMovesUci: unresolved,
        readiness: unresolved.length ? 'PARTIAL' : 'ALL_MOVES_CLASSIFIED',
    };
}
export type AnswerLookup =
    | { kind: 'ILLEGAL'; quality: 'UNKNOWN'; assessment: null; coverageGroup: null; pending: false }
    | { kind: 'PENDING'; quality: 'UNKNOWN'; assessment: MoveAssessment | null; coverageGroup: null; pending: true }
    | { kind: 'INDIVIDUAL'; quality: 'GOOD' | 'BELOW_STANDARD'; assessment: MoveAssessment; coverageGroup: null; pending: boolean }
    | { kind: 'GROUP'; quality: 'BELOW_STANDARD'; assessment: null; coverageGroup: CoverageGroup; pending: true };
/** Absence from top-K is always PENDING, never a negative verdict. */
export function lookupAnswer(index: AnswerIndex, moveUci: string, assessments: readonly MoveAssessment[], groups: readonly CoverageGroup[], frame?: ComparisonFrame): AnswerLookup {
    if (!index.legalMovesUci.includes(moveUci)) return { kind: 'ILLEGAL', quality: 'UNKNOWN', assessment: null, coverageGroup: null, pending: false };
    if (frame && (frame.id !== index.frameId || frame.status !== 'CURRENT')) return { kind: 'PENDING', quality: 'UNKNOWN', assessment: null, coverageGroup: null, pending: true };
    const candidates = assessments.filter(a => index.assessmentIds.includes(a.id) && a.contextId === index.contextId && a.frameId === index.frameId && a.moveUci === moveUci);
    const supported = candidates.find(a => a.qualitySupport === 'SUPPORTED' && a.quality !== 'UNKNOWN');
    if (supported && supported.quality !== 'UNKNOWN') return { kind: 'INDIVIDUAL', quality: supported.quality, assessment: supported, coverageGroup: null, pending: supported.pending.length > 0 };
    const group = groups.find(g => index.coverageGroupIds.includes(g.id) && g.contextId === index.contextId && g.frameId === index.frameId && g.movesUci.includes(moveUci));
    if (group) return { kind: 'GROUP', quality: 'BELOW_STANDARD', assessment: null, coverageGroup: group, pending: true };
    return { kind: 'PENDING', quality: 'UNKNOWN', assessment: candidates.at(-1) ?? null, coverageGroup: null, pending: true };
}
export function deriveRootAnswerIndex(revision: Pick<PracticeMomentRevision, 'source' | 'frames' | 'assessments' | 'coverageGroups'>, frame: ComparisonFrame, preferredMoveUci: string): AnswerIndex {
    return deriveAnswerIndex({ contextId: revision.source.contextId, frameId: frame.id, legalMovesUci: legalMovesUci(revision.source.fen), preferredMoveUci, assessments: revision.assessments, coverageGroups: revision.coverageGroups });
}
