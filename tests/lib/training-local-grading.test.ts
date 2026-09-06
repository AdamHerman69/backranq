import { assessmentPositionKey } from '@/lib/training/assessmentIdentity';
import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';

import type {
    EvalResult,
} from '@/lib/analysis/stockfishClient';
import type {
    TrainingGradingManifestDto,
    TrainingSolutionTreeNodeDto,
} from '@/lib/training/api';
import {
    gradeKnownLocalMove,
    gradeUnknownLocalMove,
    localContinuationForMove,
} from '@/lib/training/localGrading';

const rootFen =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const rootNode: TrainingSolutionTreeNodeDto = {
    fen: rootFen,
    contextId: assessmentPositionKey(rootFen, []),
    positionHistory: [],
    ply: 0,
    role: 'USER',
    acceptedMovesUci: ['d2d4'],
    branches: [
        {
            moveUci: 'd2d4',
            best: true,
            child: {
                fen: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1',
                contextId: 'terminal',
                positionHistory: [rootFen],
                ply: 1,
                role: 'TERMINAL',
                acceptedMovesUci: [],
                branches: [],
            },
        },
    ],
};

function manifest(): TrainingGradingManifestDto {
    return {
        version: 1,
        decision: { status: 'CONFIRMED_MISTAKE', reason: 'matched tests' },
        answerCoverage: { version: 1, contextId: rootNode.contextId, referenceId: 'reference', policyVersion: 3, status: 'PARTIAL', legalMovesUci: new Chess(rootFen).moves({verbose:true}).map(m => m.from + m.to), assessedMovesUci: ['d2d4'], coveredMovesUci: [], reason: 'bounded' },
        continuation: { status: 'NONE', explanationAvailable: false, gradedContinuationReady: false },
        trainingSide: 'w',
        positionHistory: [],
        originalMoveUci: 'e2e4',
        originalScoreAfter: {
            kind: 'cp',
            cp: -150,
            pov: 'WHITE',
        },
        gradingPolicy: {
            version: 3,
            pov: 'TRAINING_SIDE',
            best: { maxCpLoss: 20, maxWinChanceLoss: 0.03 },
            strong: { maxCpLoss: 50, maxWinChanceLoss: 0.05 },
            success: {
                maxCpLoss: 100,
                maxWinChanceLoss: 0.1,
                preserveOutcome: true,
            },
            improvement: {
                minRecoveredCp: 50,
                minRecoveredWinChance: 0.05,
            },
            unknownMove: 'EVALUATE',
            matePolicy: 'EXACT',
            tablebasePolicy: 'EXACT',
        },
        acceptanceFrontier: {
            version: 1,
            status: rootNode.alternativesComplete
                ? 'STABLE'
                : 'OPEN',
            targetCutoffCp: 100,
            effectiveCutoffCp: rootNode.alternativesComplete
                ? 80
                : null,
            boundaryGapCp: rootNode.alternativesComplete ? 40 : null,
            moves: [
                { moveUci: 'd2d4', tier: 'BEST' },
                { moveUci: 'c2c4', tier: 'GOOD' },
            ],
            firstRejectedMoveUci: rootNode.alternativesComplete
                ? 'e2e4'
                : null,
        },
        solutionTree: rootNode,
        moveAssessments: [
            {
                positionKey: rootNode.contextId,
                referenceId: 'reference',
                tierStable: true,
                decisionIndex: 0,
                fen: rootFen,
                moveUci: 'd2d4',
                source: 'PRECOMPUTED',
                grade: 'BEST',
                scoreAfter: {
                    kind: 'cp',
                    cp: 100,
                    pov: 'WHITE',
                },
                evidence: {
                    bestGapCp: 0,
                    bestGapWinChance: 0,
                    preservesOutcome: true,
                },
            },
        ],
        review: {
            trainingSide: 'w',
            originalMoveUci: 'e2e4',
            submittedMoveUci: null,
            bestMoveUci: 'd2d4',
            acceptedMovesUci: ['d2d4'],
            acceptedMovesComplete: false,
            bestLineUci: ['d2d4'],
            scoreAtStart: {
                kind: 'cp',
                cp: 100,
                pov: 'WHITE',
            },
            originalDecision: {
                scoreBefore: {
                    kind: 'cp',
                    cp: 100,
                    pov: 'WHITE',
                },
                scoreAfter: {
                    kind: 'cp',
                    cp: -150,
                    pov: 'WHITE',
                },
                cpLoss: 250,
                winChanceLoss: 0.3,
            },
            comparison: null,
            sourceKinds: ['MY_MISTAKE'],
            lessonKinds: ['AVOID_MISTAKE'],
            themes: [],
            source: {
                gameId: 'game-1',
                provider: 'chesscom',
                playedAt: '2026-07-30T00:00:00.000Z',
                decisionPly: 0,
            },
        },
    };
}

function evaluation(
    fen: string,
    cp: number
): EvalResult {
    return {
        fen,
        bestMoveUci: 'a2a3',
        pvUci: ['a2a3'],
        score: { type: 'cp', value: cp },
        depth: 18,
        nodes: 140_000,
    };
}

describe('local practice grading', () => {
    it('grades a context-matched downloaded answer immediately', () => {
        expect(gradeKnownLocalMove({ manifest: manifest(), node: rootNode, moveUci: 'd2d4' })?.result).toEqual({ status: 'GRADED', grade: 'BEST', accepted: true });
    });
    it('does not infer original mistake severity from move identity alone', () => {
        expect(gradeKnownLocalMove({ manifest: manifest(), node: rootNode, moveUci: 'e2e4' })).toBeNull();
    });
    it('ignores a same-FEN assessment from a different history or reference', () => {
        const m = manifest();
        m.moveAssessments[0].positionKey = 'different-history';
        expect(gradeKnownLocalMove({ manifest: m, node: rootNode, moveUci: 'd2d4' })).toBeNull();
        m.moveAssessments[0].positionKey = rootNode.contextId;
        m.moveAssessments[0].referenceId = 'stale-reference';
        expect(gradeKnownLocalMove({ manifest: m, node: rootNode, moveUci: 'd2d4' })).toBeNull();
    });
    it('does not treat a complete old frontier or a tree branch as answer coverage', () => {
        const m = manifest();
        const node = { ...rootNode, alternativesComplete: true };
        expect(gradeKnownLocalMove({ manifest: m, node, moveUci: 'a2a3' })).toBeNull();
    });
    it('uses certified below-boundary coverage for an immediate generic verdict', () => {
        const m = manifest();
        m.answerCoverage.status = 'QUALITY_BOUNDARY_VERIFIED';
        m.answerCoverage.coveredMovesUci = ['a2a3'];
        expect(gradeKnownLocalMove({ manifest: m, node: rootNode, moveUci: 'a2a3' })).toMatchObject({ result: { grade: 'DIFFERENT_MISTAKE', accepted: false }, refinementNeeded: true });
        expect(gradeKnownLocalMove({ manifest: m, node: rootNode, moveUci: 'h2h3' })).toBeNull();
    });
    it('keeps confirmed accepted membership despite fine-tier drift', () => {
        const m = manifest(); m.moveAssessments[0].tierStable = false;
        expect(gradeKnownLocalMove({ manifest: m, node: rootNode, moveUci: 'd2d4' })).toMatchObject({ result: { grade: 'GOOD', accepted: true }, refinementNeeded: true });
    });
    it('locally grades unknown moves with matched fresh scope and original reference', async () => {
        const evalPosition = vi.fn(async ({ fen, rootMoves }: {fen:string;rootMoves?:string[]}) => evaluation(fen, rootMoves?.[0] === 'e2e4' ? -150 : rootMoves ? 70 : 100));
        const result = await gradeUnknownLocalMove({ engine: {evalPosition, analyzeMultiPv:vi.fn()}, manifest: manifest(), node: rootNode, moveUci:'a2a3' });
        expect(result).toMatchObject({ source: 'CLIENT_EVALUATED', result: { grade: 'STRONG', accepted:true }, clientEvidence:{ contextId:rootNode.contextId, metrics:{bestGapCp:30,recoveredCp:220,stable:true}, searches:[{nodes:100000},{nodes:200000}] }});
        expect(evalPosition).toHaveBeenCalledTimes(8);
        expect(evalPosition).toHaveBeenCalledWith(expect.objectContaining({ fen: rootFen, rootMoves:['a2a3'], previousFens:[], reuse:'FRESH_REQUIRED', nodes:200000 }));
    });
    it('escalates unstable tiers once and then leaves the answer unresolved', async () => {
        const evalPosition = vi.fn(async ({fen,rootMoves,nodes}:{fen:string;rootMoves?:string[];nodes?:number}) => evaluation(fen, rootMoves?.[0] === 'e2e4' ? -150 : rootMoves ? (nodes === 200000 ? -80 : 90) : 100));
        const result = await gradeUnknownLocalMove({engine:{evalPosition,analyzeMultiPv:vi.fn()},manifest:manifest(),node:rootNode,moveUci:'a2a3'});
        expect(result.result).toEqual({status:'UNRESOLVED',reason:'UNSTABLE_EVIDENCE'});
        expect(evalPosition).toHaveBeenCalledTimes(12);
        expect(Math.max(...evalPosition.mock.calls.map(call=>call[0].nodes ?? 0))).toBe(400000);
    });
    it('does not push an unlisted accepted move into another branch continuation', () => {
        expect(localContinuationForMove({node:rootNode,moveUci:'a2a3'})).toBeNull();
    });
});

it('enforces a total wall budget even while the engine is initializing', async () => {
    vi.useFakeTimers();
    const cancelAll = vi.fn();
    try {
        const pending = gradeUnknownLocalMove({engine:{evalPosition:vi.fn(()=>new Promise<EvalResult>(()=>{})),analyzeMultiPv:vi.fn(),cancelAll},manifest:manifest(),node:rootNode,moveUci:'a2a3'});
        const assertion=expect(pending).rejects.toThrow('Local grading budget exhausted');
        await vi.advanceTimersByTimeAsync(20000);
        await assertion;
        expect(cancelAll).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
});

it('uses shared rule-exact mate zero without evaluating a terminal child', async () => {
    const fen='7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
    const node={...rootNode,fen,contextId:assessmentPositionKey(fen,[]),branches:[]};
    const m=manifest();m.originalMoveUci='f7e6';m.solutionTree=node;m.answerCoverage.contextId=node.contextId;node.acceptedMovesUci=['f7g7'];m.moveAssessments=[];
    const evalPosition=vi.fn(async()=>({...evaluation(fen,0),bestMoveUci:'f7g7',score:{type:'mate' as const,value:1}}));
    const result=await gradeUnknownLocalMove({engine:{evalPosition,analyzeMultiPv:vi.fn()},manifest:m,node,moveUci:'f7g7'});
    expect(result).toMatchObject({result:{grade:'BEST',accepted:true},scoreAfter:{kind:'mate',plies:0,winner:'WHITE'}});
    expect(evalPosition).toHaveBeenCalledTimes(4);
});

it.each([{bestGapCp:200,bestGapWinChance:0.01},{bestGapCp:0,bestGapWinChance:0.2}])('rejects a stored GOOD tier that violates either shared quality tolerance: %j', gaps => {
    const m=manifest();m.moveAssessments[0].grade='GOOD';m.moveAssessments[0].evidence={...gaps,stable:true,evidenceModel:'MATCHED_WDL'};
    expect(gradeKnownLocalMove({manifest:m,node:rootNode,moveUci:'d2d4'})?.result).toMatchObject({status:'GRADED',accepted:false});
});

it('requires explicit contextual membership support when comparison metrics are missing',()=>{
    const m=manifest();m.moveAssessments[0].scoreAfter=null;m.moveAssessments[0].evidence={};
    expect(gradeKnownLocalMove({manifest:m,node:rootNode,moveUci:'d2d4'})).toBeNull();
    m.moveAssessments[0].evidence={membership:{status:'ACCEPTED',stable:true,contextId:rootNode.contextId,referenceId:'reference',policyVersion:3}};
    expect(gradeKnownLocalMove({manifest:m,node:rootNode,moveUci:'d2d4'})).toMatchObject({result:{grade:'GOOD',accepted:true},evidence:{kind:'SUPPORTED_ACCEPTED_MEMBERSHIP'}});
});

it('records a distinct local reference and flags a freshly superseded canonical best',async()=>{
    const evalPosition=vi.fn(async({fen,rootMoves}:{fen:string;rootMoves?:string[]})=>({...evaluation(fen,rootMoves?.[0]==='e2e4'?-150:rootMoves?.[0]==='d2d4'?100:rootMoves?120:130),bestMoveUci:rootMoves?.[0]??'h2h3'}));
    const result=await gradeUnknownLocalMove({engine:{evalPosition,analyzeMultiPv:vi.fn()},manifest:manifest(),node:rootNode,moveUci:'a2a3'});
    expect(result).toMatchObject({result:{grade:'BEST',accepted:true},clientEvidence:{referenceId:'reference',localReference:{bestMoveUci:'h2h3',bestScore:{cp:130},canonicalBestMoveUci:'d2d4',canonicalScore:{cp:100},canonicalReferenceOutdated:true},metrics:{referenceOutdated:false}}});
    expect(result.clientEvidence?.localReference.id).not.toBe('reference');
});

it('retries an engine failure once using a replacement worker within the same budget', async()=>{
    const evalPosition=vi.fn(async({fen,rootMoves}:{fen:string;rootMoves?:string[]})=>({...evaluation(fen,rootMoves?.[0]==='e2e4'?-150:rootMoves?70:100),bestMoveUci:'d2d4'}));
    const retryEngine=vi.fn(()=>({evalPosition,analyzeMultiPv:vi.fn()}));
    const result=await gradeUnknownLocalMove({engine:{evalPosition:vi.fn().mockRejectedValue(new Error('worker failed')),analyzeMultiPv:vi.fn()},retryEngine,manifest:manifest(),node:rootNode,moveUci:'a2a3'});
    expect(result.result).toMatchObject({status:'GRADED',grade:'STRONG'});
    expect(retryEngine).toHaveBeenCalledOnce();
});

it('does not grant a second wall budget when the first engine never responds', async()=>{
    vi.useFakeTimers();
    const retryEngine=vi.fn();
    try {
        const pending=gradeUnknownLocalMove({engine:{evalPosition:vi.fn(()=>new Promise<EvalResult>(()=>{})),analyzeMultiPv:vi.fn()},retryEngine,manifest:manifest(),node:rootNode,moveUci:'a2a3'});
        const assertion=expect(pending).rejects.toThrow('Local grading budget exhausted');
        await vi.advanceTimersByTimeAsync(20000);await assertion;
        expect(retryEngine).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
});

it('recognizes mandatory fivefold repetition from the replay history without claiming a tablebase probe',async()=>{
    const board=new Chess();const history:string[]=[];
    for (const move of [...Array(3).fill(['Nf3','Nf6','Ng1','Ng8']).flat(),'Nf3','Nf6','Ng1']) {history.push(board.fen());board.move(move);}
    const node={...rootNode,fen:board.fen(),positionHistory:history,contextId:assessmentPositionKey(board.fen(),history),acceptedMovesUci:['d7d5'],branches:[]};
    const m=manifest();m.trainingSide='b';m.originalMoveUci='e7e5';m.solutionTree=node;m.moveAssessments=[];m.answerCoverage.contextId=node.contextId;
    const evalPosition=vi.fn(async()=>({...evaluation(node.fen,0),bestMoveUci:'d7d5',wdl:{win:0,draw:1000,loss:0}}));
    const result=await gradeUnknownLocalMove({engine:{evalPosition,analyzeMultiPv:vi.fn()},manifest:m,node,moveUci:'f6g8'});
    expect(result).toMatchObject({source:'CLIENT_EVALUATED',evidence:{kind:'LOCAL_RULE',terminal:'FIVEFOLD_REPETITION'}});
});

it('accepts stable quality membership when the fine tier changes between local passes',async()=>{
    const evalPosition=vi.fn(async({fen,rootMoves,nodes}:{fen:string;rootMoves?:string[];nodes?:number})=>({...evaluation(fen,rootMoves?.[0]==='e2e4'?-150:rootMoves?.[0]==='a2a3'?(nodes===100000?90:65):100),bestMoveUci:'d2d4'}));
    const result=await gradeUnknownLocalMove({engine:{evalPosition,analyzeMultiPv:vi.fn()},manifest:manifest(),node:rootNode,moveUci:'a2a3'});
    expect(result).toMatchObject({result:{grade:'STRONG',accepted:true},clientEvidence:{tierStable:false,metrics:{stable:true}}});
    expect(result.clientEvidence?.searches).toHaveLength(2);
});
