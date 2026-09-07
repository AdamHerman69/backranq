import { practicePositionFixture } from '../helpers/practice-position';
import { originalDecisionForPracticeManifest } from '@/lib/training/practiceSourceBinding';
import { practiceV4Fixture } from '../helpers/practice-v4';
import { describe, expect, it, vi } from 'vitest';
import {
    type SolutionRevisionInput,
    type TrainingMomentCandidate,
} from '@/lib/training/contracts';
import { solutionSemanticsHash } from '@/lib/training/contractHashes.server';
import {
    persistTrainingMomentsInTransaction,
    type PersistableTrainingMoment,
} from '@/lib/training/persistence';
import { replaceTrainingMomentsInTransaction } from '@/lib/api/trainingMomentPersistence';

const rootFen = practiceV4Fixture().source.fen;
const sourceHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
function solution(explanationMove = 'e2e4'): SolutionRevisionInput {
    const manifest = practiceV4Fixture();
    manifest.executionProfileId = 'config-1';
    manifest.executionProfileSnapshot.id = 'config-1';
    manifest.source = { ...manifest.source, gameId: 'game-1', sourcePgnHash: sourceHash, decisionPly: 12 };
    manifest.continuation.explanationLines = [{ startContextId: manifest.source.contextId, movesUci: [explanationMove], stopReason: 'FIXTURE' }];
    const result = { manifest, configHash: 'config-1' };
    manifest.semanticHash = solutionSemanticsHash(result);
    return result;
}

function moment(
    overrides: Partial<PersistableTrainingMoment> = {}
): PersistableTrainingMoment {
    return {
        decisionPly: 12,
        fen: rootFen,
        positionHistory: [],
        sideToMove: 'w',
        originalMoveUci: 'a2a3',
        originalDecision: originalDecisionForPracticeManifest(solution().manifest),
        confidence: 0.94,
        phase: 'ENDGAME',
        sourceKinds: ['MY_MISTAKE'],
        lessonKinds: ['AVOID_MISTAKE'],
        themes: ['quietmove'],
        solution: solution(),
        ...overrides,
    };
}

function currentRevisionEvidence() {
    const input = solution();
    return { configHash: input.configHash, generatorVersion: input.manifest.generatorVersion, trainable: true, manifest: input.manifest };
}

function existingMoment(
    currentSolutionRevisionId: string | null = 'revision-current'
) {
    return {
        id: 'moment-1',
        momentKey: 'stored-key',
        sourcePgnHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        decisionPly: 12,
        fen: moment().fen,
        positionHistory: [],
        sideToMove: 'w',
        originalMoveUci: 'a2a3',
        scoreBefore: moment().originalDecision.scoreBefore,
        scoreAfter: moment().originalDecision.scoreAfter,
        cpLoss: 120,
        winChanceLoss: 0.31,
        confidence: 0.94,
        phase: 'ENDGAME',
        currentSolutionRevisionId,
        archivedAt: null,
        sourceKinds: ['MY_MISTAKE'],
        lessonKinds: ['AVOID_MISTAKE'],
        themes: ['quietmove'],
    };
}

function transaction() {
    const tx = {
        analysisRun: {
            findFirst: vi.fn().mockResolvedValue({ id: 'run-1', configSnapshot: { extractor: { confirmNodes: 100_000, gradingPolicy: solution().manifest.policySnapshot } } }),
        },
        trainingMoment: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({ id: 'moment-1' }),
            update: vi.fn().mockResolvedValue({ id: 'moment-1' }),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        solutionRevision: {
            findUnique: vi.fn(),
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockImplementation(({ data }) =>
                Promise.resolve({
                    id: 'revision-new',
                    momentId: data.momentId,
                    solutionHash: data.solutionHash,
                })
            ),
        },
        trainingMomentObservation: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({
                momentId: 'moment-1',
                analysisRunId: 'run-1',
            }),
        },
    };
    return tx;
}

function persist(
    tx: ReturnType<typeof transaction>,
    moments: PersistableTrainingMoment[],
    analysisRunId = 'run-1',
    manifestOverrides: Partial<import('@/lib/analysis/extractTrainingMoments').ExtractionCompletionManifest> = {}
) {
    return persistTrainingMomentsInTransaction({
        tx: tx as never,
        userId: 'user-1',
        gameId: 'game-1',
        sourcePgnHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        analysisRunId,
        analysisConfigHash: 'config-1',
        extractionManifest: {
            scope: 'FULL_GAME',
            scanComplete: true,
            extractionComplete: true,
            decisionOutcomes: [],
            version: 1,
            complete: true,
            sourceGameId: 'game-1',
            sourcePgnHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            scannedPlies: 20,
            expectedPlies: 20,
            termination: 'COMPLETED',
            errors: [],
            ...manifestOverrides,
        },
        moments,
    });
}

describe('canonical training persistence', () => {
    it('merges avoid and missed-opportunity metadata into one stable moment', async () => {
        const tx = transaction();
        const result = await persist(tx, [
            moment(),
            moment({
                sourceKinds: ['MISSED_OPPORTUNITY'],
                lessonKinds: ['PUNISH_MISTAKE'],
                themes: ['QuietMove', 'defense'],
            }),
        ]);

        expect(result.upserted).toBe(1);
        expect(Object.values(result.momentIdsByKey)).toEqual(['moment-1']);
        expect(tx.trainingMoment.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    sourceKinds: [
                        'MY_MISTAKE',
                        'MISSED_OPPORTUNITY',
                    ],
                    lessonKinds: [
                        'AVOID_MISTAKE',
                        'PUNISH_MISTAKE',
                    ],
                    themes: ['defense', 'quietmove'],
                    scoreBefore: {
                        kind: 'cp',
                        cp: 30,
                        pov: 'WHITE',
                    },
                    cpLoss: 230,
                    confidence: 0.94,
                }),
            })
        );
        expect(tx.solutionRevision.create).toHaveBeenCalledTimes(1);
        expect(tx.solutionRevision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ manifest: expect.objectContaining({ contractVersion: 4, momentId: 'moment-1', revisionId: expect.any(String) }), trainable: true }) }));
    });

    it('rejects conflicting solution hashes for one canonical decision', async () => {
        const tx = transaction();

        await expect(
            persist(tx, [
                moment(),
                moment({ solution: solution('d2d4') }),
            ])
        ).rejects.toThrow(
            'Conflicting solution hashes share one training moment identity'
        );

        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
        expect(tx.trainingMoment.updateMany).not.toHaveBeenCalled();
        expect(tx.solutionRevision.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate assessment identities before any moment write', async () => {
        const tx = transaction();
        const duplicated = solution();
        duplicated.manifest.assessments.push(structuredClone(duplicated.manifest.assessments[0]));
        duplicated.manifest.semanticHash = solutionSemanticsHash(duplicated);
        await expect(persist(tx, [moment({ solution: duplicated })])).rejects.toThrow(/Duplicate assessment ID/);
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it('keeps repeated boards at different source decisions distinct', async () => {
        const tx = transaction();
        const later = solution();
        later.manifest.source.decisionPly = 14;
        later.manifest.semanticHash = solutionSemanticsHash(later);
        await persist(tx, [moment(), moment({ decisionPly: 14, solution: later })]);
        expect(tx.trainingMoment.upsert).toHaveBeenCalledTimes(2);
        const keys = tx.trainingMoment.upsert.mock.calls.map(([input]) => input.where.momentKey);
        expect(new Set(keys).size).toBe(2);
    });

    it('reuses the current immutable revision when semantics are unchanged', async () => {
        const tx = transaction();
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({
            ...existingMoment(),
            momentKey: where.momentKey,
        }));
        tx.solutionRevision.findUnique.mockResolvedValue({
            ...currentRevisionEvidence(),
            id: 'revision-current',
            momentId: 'moment-1',
            solutionHash: solution().manifest.semanticHash,
        });

        const result = await persist(tx, [moment()], 'run-2');

        expect(tx.solutionRevision.create).not.toHaveBeenCalled();
        expect(tx.trainingMomentObservation.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                momentId: 'moment-1',
                analysisRunId: 'run-2',
                solutionRevisionId: 'revision-current',
                observedSolutionHash: solution().manifest.semanticHash,
            }),
        });
        expect(Object.values(result.solutionRevisionIdsByKey)).toEqual([
            'revision-current',
        ]);
        expect(tx.trainingMoment.update).toHaveBeenCalledWith({
            where: { id: 'moment-1' },
            data: { currentSolutionRevisionId: 'revision-current' },
        });
    });

    it('appends and activates a revision only when solution semantics change', async () => {
        const tx = transaction();
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({
            ...existingMoment(),
            momentKey: where.momentKey,
        }));
        tx.solutionRevision.findUnique.mockResolvedValue({
            ...currentRevisionEvidence(),
            id: 'revision-current',
            momentId: 'moment-1',
            solutionHash: solution('d2d4').manifest.semanticHash,
        });
        tx.solutionRevision.findFirst.mockResolvedValue({ revision: 4 });

        await persist(tx, [moment()], 'run-2');

        expect(tx.solutionRevision.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    momentId: 'moment-1',
                    analysisRunId: 'run-2',
                    revision: 5,
                    solutionHash: solution().manifest.semanticHash,
                }),
            })
        );
        expect(tx.trainingMoment.update).toHaveBeenCalledWith({
            where: { id: 'moment-1' },
            data: { currentSolutionRevisionId: 'revision-new' },
        });
    });

    it('appends immutable provenance when fresh physical evidence preserves solution semantics', async () => {
        const tx = transaction();
        const previous = solution();
        const changed = solution();
        Object.values(changed.manifest.evidence.searches)[0].sessionId = 'fresh-physical-session';
        expect(solutionSemanticsHash(changed)).toBe(previous.manifest.semanticHash);
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({ ...existingMoment(), momentKey: where.momentKey }));
        tx.solutionRevision.findUnique.mockResolvedValue({ ...currentRevisionEvidence(), id: 'revision-current', momentId: 'moment-1', solutionHash: previous.manifest.semanticHash });
        tx.solutionRevision.findFirst.mockResolvedValue({ revision: 4 });
        await persist(tx, [moment({ solution: changed })], 'run-evidence');
        expect(tx.solutionRevision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ revision: 5, solutionHash: changed.manifest.semanticHash }) }));
    });

    it('rejects conflicting results from the same analysis run', async () => {
        const tx = transaction();
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({
            ...existingMoment(),
            momentKey: where.momentKey,
        }));
        tx.solutionRevision.findUnique.mockResolvedValue({
            ...currentRevisionEvidence(),
            id: 'revision-current',
            momentId: 'moment-1',
            solutionHash: solution('d2d4').manifest.semanticHash,
        });
        tx.trainingMomentObservation.findUnique.mockResolvedValue({
            solutionRevisionId: 'revision-run',
            observedSolutionHash: solution('g1f3').manifest.semanticHash,
        });

        await expect(persist(tx, [moment()])).rejects.toThrow(
            /different solution semantics/
        );
        expect(tx.trainingMoment.update).not.toHaveBeenCalled();
    });

    it('rejects a current revision linked to another moment', async () => {
        const tx = transaction();
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({
            ...existingMoment(),
            momentKey: where.momentKey,
        }));
        tx.solutionRevision.findUnique.mockResolvedValue({
            ...currentRevisionEvidence(),
            id: 'revision-current',
            momentId: 'other-moment',
            solutionHash: solution().manifest.semanticHash,
        });

        await expect(persist(tx, [moment()])).rejects.toThrow(
            /does not belong/
        );
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it('ignores unproved negative diagnostic outcomes without changing stored revisions or moments', async () => {
        const tx = transaction();
        const result = await persist(tx, [], 'run-1', { decisionOutcomes: [{ decisionPly: 12, status: 'NOT_A_MISTAKE', reason: 'ORIGINAL_MOVE_QUALITY_CONFIRMED' }] });
        expect(result).toMatchObject({ upserted: 0, staleArchived: 0 });
        expect(tx.trainingMoment.updateMany).not.toHaveBeenCalled();
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
        expect(tx.solutionRevision.create).not.toHaveBeenCalled();
    });

    it('archives an existing moment only with a validated canonical negative revision', async () => {
        const tx = transaction();
        tx.trainingMoment.findUnique.mockImplementation(async ({ where }) => ({ ...existingMoment(), momentKey: where.momentKey }));
        tx.solutionRevision.findUnique.mockResolvedValue({ ...currentRevisionEvidence(), id: 'revision-current', momentId: 'moment-1', solutionHash: solution().manifest.semanticHash });
        const manifest = practicePositionFixture({ fen: rootFen, originalMoveUci: 'a2a3', bestMoveUci: 'e2e4', gameId: 'game-1', sourcePgnHash: sourceHash, decisionPly: 12, configHash: 'config-1', scores: { a2a3: 30 } });
        expect(manifest.decision.status).toBe('NOT_A_MISTAKE');
        const result = await persist(tx, [moment({ solution: { manifest, configHash: 'config-1' }, originalDecision: originalDecisionForPracticeManifest(manifest) })]);
        expect(result).toMatchObject({ staleArchived: 1, upserted: 0 });
        expect(tx.trainingMoment.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ status: 'ARCHIVED', archivedAt: expect.any(Date) }) }));
        expect(tx.solutionRevision.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ trainable: false, manifest: expect.objectContaining({ decision: expect.objectContaining({ status: 'NOT_A_MISTAKE' }) }) }) }));
        expect(tx.trainingMoment.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a diagnostic outcome contradicting a canonical decision before any writes', async () => {
        const tx = transaction();
        await expect(persist(tx, [moment()], 'run-1', { decisionOutcomes: [{ decisionPly: 12, status: 'NOT_A_MISTAKE', reason: 'CONTRADICTORY_DIAGNOSTIC' }] })).rejects.toThrow(/contradicts/);
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
        expect(tx.solutionRevision.create).not.toHaveBeenCalled();
    });

    it('does not archive previously confirmed moments merely omitted by a new scan', async () => {
        const tx = transaction();
        await expect(persist(tx, [])).resolves.toMatchObject({staleArchived:0});
        expect(tx.trainingMoment.updateMany).not.toHaveBeenCalled();
    });

    it('does not suspend prior proof based only on unresolved diagnostic outcomes', async () => {
        const tx = transaction();
        await persist(tx, [], 'run-2', { decisionOutcomes: [{ decisionPly: 12, status: 'UNRESOLVED', reason: 'MISTAKE_COMPARISON_UNRESOLVED' }] });
        expect(tx.trainingMoment.updateMany).not.toHaveBeenCalled();
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it('requires a complete extraction manifest before any read or write', async () => {
        const tx = transaction();

        await expect(
            persist(tx, [], 'run-1', {
                complete: false,
                scannedPlies: 9,
                expectedPlies: 10,
                termination: 'SOURCE_REPLAY_STOPPED',
                errors: ['invalid PGN suffix'],
            })
        ).rejects.toThrow(/complete extraction manifest/i);

        expect(tx.analysisRun.findFirst).not.toHaveBeenCalled();
        expect(tx.trainingMoment.updateMany).not.toHaveBeenCalled();
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it('rejects analysis-run provenance mismatches before moment writes', async () => {
        const tx = transaction();
        tx.analysisRun.findFirst.mockResolvedValue(null);

        await expect(persist(tx, [moment()])).rejects.toThrow(
            /provenance does not match/i
        );

        expect(tx.analysisRun.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'run-1',
                userId: 'user-1',
                gameId: 'game-1',
                inputPgnHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                configHash: 'config-1',
                status: 'RUNNING',
            },
            select: { id: true, configSnapshot: true },
        });
        expect(tx.trainingMoment.findUnique).not.toHaveBeenCalled();
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it('rejects candidates from another game before any write', async () => {
        const tx = transaction();
        const candidate: TrainingMomentCandidate = {
            sourceGameId: 'other-game',
            sourceProvider: 'lichess',
            sourcePlayedAt: '2026-07-05T12:00:00.000Z',
            sourcePgnHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ...moment(),
            confidence: 0.94,
            phase: 'ENDGAME',
        };

        await expect(
            replaceTrainingMomentsInTransaction({
                tx: tx as never,
                userId: 'user-1',
                gameId: 'game-1',
                sourceProvider: 'lichess',
                sourcePlayedAt: new Date('2026-07-05T12:00:00.000Z'),
                sourcePgnHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                analysisRunId: 'run-1',
                analysisConfigHash: 'config-1',
                extractionManifest: {
            scope: 'FULL_GAME',
            scanComplete: true,
            extractionComplete: true,
            decisionOutcomes: [],
                    version: 1,
                    complete: true,
                    sourceGameId: 'game-1',
                    sourcePgnHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    scannedPlies: 20,
                    expectedPlies: 20,
                    termination: 'COMPLETED',
                    errors: [],
                },
                moments: [candidate],
            })
        ).rejects.toThrow(/completed game/);
        expect(tx.trainingMoment.findUnique).not.toHaveBeenCalled();
    });
});


describe('authoritative revision binding', () => {
    it('rejects a valid manifest from a different source before any write', async () => {
        const tx = transaction();
        const mismatched = solution();
        mismatched.manifest.source.gameId = 'other-game';
        mismatched.manifest.semanticHash = solutionSemanticsHash(mismatched);
        await expect(persist(tx, [moment({ solution: mismatched })])).rejects.toThrow(/source/i);
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });
    it('rejects altered original-decision display scores', async () => {
        const tx = transaction();
        const value = moment(); value.originalDecision.cpLoss = 999;
        await expect(persist(tx, [value])).rejects.toThrow(/source|original.decision|projection/i);
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });
    it('rejects a self-consistent profile whose budget is not the authoritative run budget', async () => {
        const tx = transaction();
        tx.analysisRun.findFirst.mockResolvedValue({ id: 'run-1', configSnapshot: { extractor: { confirmNodes: 200_000, gradingPolicy: solution().manifest.policySnapshot } } });
        await expect(persist(tx, [moment()])).rejects.toThrow(/profile/i);
        expect(tx.trainingMoment.upsert).not.toHaveBeenCalled();
    });
});
