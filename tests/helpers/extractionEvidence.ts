import { Chess } from 'chess.js';
import { assessmentPositionKey, appendAssessmentHistory } from '@/lib/training/assessmentIdentity';
import type { SolutionRevisionInput } from '@/lib/training/contracts';
import { moveToUci } from '@/lib/chess/utils';

type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

export const TEST_REFERENCE_ID = 'test-reference-v1';

function key(fen: string, history: string[]) {
    try { return assessmentPositionKey(fen, history); } catch { return fen; }
}

export function fixtureTree<T>(tree: T, history: string[] = [], referenceId = TEST_REFERENCE_ID): T {
    if (!tree || typeof tree !== 'object' || !('fen' in tree)) return tree;
    const node = tree as { fen: string; ply?: number; role?: string; answerCoverage?: unknown; acceptedMovesUci?: string[]; branches?: { child: unknown }[] };
    let legal = node.acceptedMovesUci ?? [];
    try { legal = new Chess(node.fen).moves({verbose:true}).map(moveToUci); } catch { /* Symbolic hash fixtures. */ }
    return {
        ...tree,
        ...(node.role === 'USER' && (node.ply ?? 0) > 0 && !node.answerCoverage ? {answerCoverage:{
            version:1, contextId:key(node.fen,history),status:'PARTIAL',legalMovesUci:legal,
            assessedMovesUci:node.acceptedMovesUci ?? [],coveredMovesUci:[],referenceId,policyVersion:3,reason:'TEST_CHILD_COVERAGE',
        }} : {}),
        contextId: key(node.fen, history),
        positionHistory: history,
        branches: node.branches?.map(branch => ({
            ...branch,
            child: fixtureTree(branch.child, appendAssessmentHistory(history, node.fen), referenceId),
        })) ?? [],
    };
}

/** Explicit current-contract fixture builder; never used by application readers. */
export function fixtureSolution<const T extends {
    acceptedMovesUci: string[];
    moveAssessments: { fen: string; moveUci: string; decisionIndex: number; positionKey?: string }[];
    solutionTree: unknown;
}>(solution: T, history: string[] = []): Mutable<Omit<T, 'moveAssessments'>> & Pick<SolutionRevisionInput,
    'decision' | 'answerCoverage' | 'continuation' | 'moveAssessments'> {
    const fen = solution.moveAssessments[0]?.fen ?? '';
    let legal = solution.acceptedMovesUci;
    try { legal = new Chess(fen).moves({ verbose: true }).map(moveToUci); } catch { /* Hash-only fixtures use symbolic FENs. */ }
    return {
        ...solution,
        decision: { status: 'CONFIRMED_MISTAKE', reason: 'TEST_CONFIRMED_COMPARISON' },
        answerCoverage: {
            version: 1,
            contextId: key(fen, history),
            status: 'PARTIAL',
            legalMovesUci: legal,
            assessedMovesUci: solution.moveAssessments.filter(a => a.decisionIndex === 0).map(a => a.moveUci),
            coveredMovesUci: [],
            referenceId: TEST_REFERENCE_ID,
            policyVersion: 3,
            reason: 'TEST_PARTIAL_COVERAGE',
        },
        continuation: { status: 'GRADED_BRANCHES_READY', explanationAvailable: true, gradedContinuationReady: true },
        solutionTree: fixtureTree(solution.solutionTree, history),
        moveAssessments: solution.moveAssessments.map(assessment => ({
            ...assessment,
            positionKey: assessment.positionKey ?? key(assessment.fen, history),
            referenceId: TEST_REFERENCE_ID,
            tierStable: true,
        })),
    } as unknown as Mutable<Omit<T, 'moveAssessments'>> & Pick<SolutionRevisionInput, 'decision' | 'answerCoverage' | 'continuation' | 'moveAssessments'>;
}
