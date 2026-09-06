import { describe, expect, it } from 'vitest';
import { parseEnrichTrainingAttemptRequest, parseRecordTrainingAttemptRequest } from '@/lib/training/apiValidation';
import { enqueueTrainingAttempt, reconcileTrainingAttemptFlush, TRAINING_QUEUE_VERSION, type QueuedTrainingAttempt } from '@/lib/training/offlineQueue';
import type { EnrichTrainingAttemptRequest, TrainingClientMoveEvidence } from '@/lib/training/api';

const attemptId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const evidence: TrainingClientMoveEvidence = { version:1,contextId:'context',referenceId:'reference',policyVersion:3,tierStable:true,localReference:{id:'local-reference',bestMoveUci:'a2a3',bestScore:{kind:'cp',cp:30,pov:'WHITE'},canonicalBestMoveUci:'e2e4',canonicalScore:{kind:'cp',cp:30,pov:'WHITE'},canonicalReferenceOutdated:false},metrics:{moveUci:'a2a3',originalMoveUci:'d2d4',stable:true,bestGapCp:30,evidenceModel:'CP_ONLY'},scoreAfter:{kind:'cp',cp:0,pov:'WHITE'},searches:[{nodes:100000,best:{},submitted:{},original:{},canonical:{}},{nodes:200000,best:{},submitted:{},original:{},canonical:{}}] };
const request: EnrichTrainingAttemptRequest = {kind:'ENRICH',clientAttemptId:attemptId,solutionRevisionId:revisionId,clientEvidenceId:'33333333-3333-4333-8333-333333333333',stepIndex:0,evaluatedAt:'2026-07-30T08:00:00.000Z',clientEvidence:evidence,grade:'STRONG'};

describe('client evidence transport',()=>{
    it('parses bounded refinement evidence and rejects nonfinite or excessive metrics',()=>{
        expect(parseEnrichTrainingAttemptRequest(request)).toEqual(request);
        expect(parseEnrichTrainingAttemptRequest({...request,clientEvidence:{...evidence,metrics:{...evidence.metrics,bestGapCp:Infinity}}})).toBeNull();
        expect(parseEnrichTrainingAttemptRequest({...request,clientEvidence:{...evidence,metrics:{...evidence.metrics,bestGapWinChance:1.1}}})).toBeNull();
        expect(parseEnrichTrainingAttemptRequest({...request,clientEvidence:{...evidence,searches:[...evidence.searches,...evidence.searches]}})).toBeNull();
    });
    it('requires explicit client provenance instead of accepting internal DYNAMIC transport',()=>{
        const record={kind:'RECORD',completedAt:request.evaluatedAt,clientAttemptId:attemptId,solutionRevisionId:revisionId,status:'GRADED',grade:'STRONG',gradingSource:'CLIENT_EVALUATED',steps:[{stepIndex:0,actor:'USER',fenBefore:'fen',moveUci:'a2a3',grade:'STRONG',source:'CLIENT_EVALUATED',clientEvidence:evidence}]};
        expect(parseRecordTrainingAttemptRequest(record)).not.toBeNull();
        expect(parseRecordTrainingAttemptRequest({...record,gradingSource:'DYNAMIC'})).toBeNull();
        expect(parseRecordTrainingAttemptRequest({...record,steps:[{...record.steps[0],clientEvidence:undefined}]})).toBeNull();
    });
    it('keeps a record and multiple refinements independent through offline reconciliation',()=>{
        const base={version:TRAINING_QUEUE_VERSION,ownerId:'owner',momentId:'moment',queuedAt:request.evaluatedAt,state:'PENDING' as const,attemptCount:0,lastAttemptAt:null,lastError:null};
        const record:QueuedTrainingAttempt={...base,request:{kind:'RECORD',clientAttemptId:attemptId,solutionRevisionId:revisionId,completedAt:request.evaluatedAt,status:'REVEALED',steps:[]}};
        const refine:QueuedTrainingAttempt={...base,request};
        const later:QueuedTrainingAttempt={...base,request:{...request,clientEvidenceId:'44444444-4444-4444-8444-444444444444'}};
        const queue=enqueueTrainingAttempt(enqueueTrainingAttempt([record],refine),later);
        expect(queue).toHaveLength(3);
        expect(reconcileTrainingAttemptFlush([record],[],queue)).toEqual([refine,later]);
        expect(enqueueTrainingAttempt(queue,refine)).toHaveLength(3);
    });
});
