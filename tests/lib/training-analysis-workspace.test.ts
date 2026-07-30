import { describe, expect, it } from 'vitest';

import {
    engineScoreForWhite,
    engineWdlForWhite,
    formatEngineScoreForWhite,
    formatEngineWdlForWhite,
    whiteExpectedScore,
} from '@/lib/analysis/evaluation';
import {
    canDeleteTrainingAnalysisVariation,
    createTrainingAnalysisTree,
    deleteTrainingAnalysisVariation,
    jumpToTrainingAnalysisNode,
    nextTrainingAnalysisNode,
    playTrainingAnalysisMove,
    previousTrainingAnalysisNode,
    promoteTrainingAnalysisVariation,
    sanitizeTrainingAnalysisTree,
    siblingTrainingAnalysisNode,
    threatModeFen,
    trainingAnalysisPath,
    trainingAnalysisPositionContext,
} from '@/lib/training/analysisTree';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 =
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_E5 =
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

function childForMove(
    tree: ReturnType<typeof createTrainingAnalysisTree>,
    parentId: string,
    moveUci: string
) {
    return tree.nodes[parentId]?.childrenIds
        .map((id) => tree.nodes[id])
        .find((node) => node?.moveUci === moveUci);
}

describe('training analysis tree', () => {
    it('reconstructs source-game context and seeds semantic branches', () => {
        const tree = createTrainingAnalysisTree({
            decisionFen: AFTER_E4_E5,
            positionHistory: [START, AFTER_E4],
            originalMoveUci: 'g1f3',
            submittedMoveUci: 'f1c4',
            bestLineUci: ['b1c3', 'g8f6'],
        });

        expect(tree.nodes[tree.rootId]?.fen).toBe(START);
        expect(
            trainingAnalysisPath(tree, tree.decisionNodeId).map(
                (node) => node.moveUci
            )
        ).toEqual([null, 'e2e4', 'e7e5']);
        expect(
            tree.nodes[tree.decisionNodeId]?.childrenIds.map(
                (id) => tree.nodes[id]?.moveUci
            )
        ).toEqual(['g1f3', 'f1c4', 'b1c3']);
        expect(tree.gameMoveNodeId).toBe(
            childForMove(tree, tree.decisionNodeId, 'g1f3')?.id
        );
        expect(tree.submittedMoveNodeId).toBe(
            childForMove(tree, tree.decisionNodeId, 'f1c4')?.id
        );
        expect(tree.nodes[tree.bestLineNodeId!]?.moveUci).toBe('g8f6');
        expect(tree.cursorId).toBe(tree.decisionNodeId);
    });

    it('derives visual context from immutable game nodes instead of separate UI state', () => {
        let tree = createTrainingAnalysisTree({
            decisionFen: AFTER_E4_E5,
            positionHistory: [START, AFTER_E4],
            originalMoveUci: 'g1f3',
            submittedMoveUci: 'f1c4',
        });

        expect(
            trainingAnalysisPositionContext(tree, tree.rootId)
        ).toBe('source');
        expect(
            trainingAnalysisPositionContext(tree, tree.decisionNodeId)
        ).toBe('decision');
        expect(
            trainingAnalysisPositionContext(tree, tree.gameMoveNodeId!)
        ).toBe('source');
        expect(
            trainingAnalysisPositionContext(
                tree,
                tree.submittedMoveNodeId!
            )
        ).toBe('analysis');

        tree = jumpToTrainingAnalysisNode(tree, tree.rootId);
        tree = playTrainingAnalysisMove(tree, 'd2d4');
        expect(trainingAnalysisPositionContext(tree)).toBe('analysis');
    });

    it('preserves sibling variations when a new move is played in the past', () => {
        const seeded = createTrainingAnalysisTree({
            decisionFen: START,
            positionHistory: [],
            originalMoveUci: 'd2d4',
        });
        const afterE4 = playTrainingAnalysisMove(seeded, 'e2e4');
        const e4Id = afterE4.cursorId;
        const backAtRoot = previousTrainingAnalysisNode(afterE4);
        const afterC4 = playTrainingAnalysisMove(backAtRoot, 'c2c4');
        const c4Id = afterC4.cursorId;
        const rootChildren = afterC4.nodes[afterC4.rootId]!.childrenIds;

        expect(
            rootChildren.map((id) => afterC4.nodes[id]?.moveUci)
        ).toEqual(['d2d4', 'e2e4', 'c2c4']);
        expect(afterC4.nodes[e4Id]).toBeDefined();
        expect(afterC4.nodes[c4Id]).toBeDefined();
    });

    it('reuses an existing move and remembers the selected continuation', () => {
        const seeded = createTrainingAnalysisTree({
            decisionFen: START,
            positionHistory: [],
            originalMoveUci: 'd2d4',
        });
        const firstE4 = playTrainingAnalysisMove(seeded, 'e2e4');
        const nodeCount = Object.keys(firstE4.nodes).length;
        const root = previousTrainingAnalysisNode(firstE4);
        const secondE4 = playTrainingAnalysisMove(root, 'e2e4');

        expect(secondE4.cursorId).toBe(firstE4.cursorId);
        expect(Object.keys(secondE4.nodes)).toHaveLength(nodeCount);
        expect(nextTrainingAnalysisNode(previousTrainingAnalysisNode(secondE4)).cursorId)
            .toBe(firstE4.cursorId);
    });

    it('selects every ancestor edge when jumping directly into a deep line', () => {
        let tree = createTrainingAnalysisTree({
            decisionFen: START,
            positionHistory: [],
            originalMoveUci: 'd2d4',
        });
        tree = playTrainingAnalysisMove(tree, 'e2e4');
        const e4Id = tree.cursorId;
        tree = playTrainingAnalysisMove(tree, 'e7e5');
        const e5Id = tree.cursorId;

        tree = jumpToTrainingAnalysisNode(tree, tree.rootId);
        tree = nextTrainingAnalysisNode(tree);
        expect(tree.cursorId).toBe(e4Id);
        tree = nextTrainingAnalysisNode(tree);
        expect(tree.cursorId).toBe(e5Id);
    });

    it('cycles variations and can promote a side line to the main line', () => {
        let tree = createTrainingAnalysisTree({
            decisionFen: START,
            positionHistory: [],
            originalMoveUci: 'd2d4',
        });
        tree = playTrainingAnalysisMove(tree, 'e2e4');
        const e4Id = tree.cursorId;
        const sibling = siblingTrainingAnalysisNode(tree, -1);
        expect(sibling.nodes[sibling.cursorId]?.moveUci).toBe('d2d4');

        const promoted = promoteTrainingAnalysisVariation(tree, e4Id);
        expect(promoted.nodes[promoted.rootId]?.childrenIds[0]).toBe(e4Id);
    });

    it('deletes only user-created subtrees and moves the cursor to their parent', () => {
        let tree = createTrainingAnalysisTree({
            decisionFen: START,
            positionHistory: [],
            originalMoveUci: 'd2d4',
        });
        tree = playTrainingAnalysisMove(tree, 'e2e4');
        const e4Id = tree.cursorId;
        tree = playTrainingAnalysisMove(tree, 'e7e5');
        const e5Id = tree.cursorId;

        expect(canDeleteTrainingAnalysisVariation(tree, e4Id)).toBe(true);
        expect(canDeleteTrainingAnalysisVariation(tree, tree.gameMoveNodeId!))
            .toBe(false);

        const deleted = deleteTrainingAnalysisVariation(tree, e4Id);
        expect(deleted.nodes[e4Id]).toBeUndefined();
        expect(deleted.nodes[e5Id]).toBeUndefined();
        expect(deleted.cursorId).toBe(deleted.rootId);
        expect(deleted.nodes[deleted.gameMoveNodeId!]).toBeDefined();
    });

    it('keeps repetitions as distinct move-path nodes', () => {
        let tree = createTrainingAnalysisTree({
            decisionFen: START,
            positionHistory: [],
        });
        for (const move of ['g1f3', 'g8f6', 'f3g1', 'f6g8']) {
            tree = playTrainingAnalysisMove(tree, move);
        }
        const path = trainingAnalysisPath(tree);
        expect(path).toHaveLength(5);
        expect(path[0]?.id).not.toBe(path[4]?.id);
        expect(path[0]?.fen.split(' ').slice(0, 4)).toEqual(
            path[4]?.fen.split(' ').slice(0, 4)
        );
    });

    it('restores only structurally and legally valid persisted trees', () => {
        const tree = playTrainingAnalysisMove(
            createTrainingAnalysisTree({
                decisionFen: START,
                positionHistory: [],
            }),
            'e2e4'
        );
        expect(
            sanitizeTrainingAnalysisTree(
                JSON.parse(JSON.stringify(tree)),
                START
            )
        ).toEqual(tree);

        const brokenParent = JSON.parse(JSON.stringify(tree));
        brokenParent.nodes[tree.cursorId].parentId = 'missing';
        expect(sanitizeTrainingAnalysisTree(brokenParent, START)).toBeNull();

        const illegalFen = JSON.parse(JSON.stringify(tree));
        illegalFen.nodes[tree.cursorId].fen = AFTER_E4_E5;
        expect(sanitizeTrainingAnalysisTree(illegalFen, START)).toBeNull();

        expect(sanitizeTrainingAnalysisTree(tree, AFTER_E4)).toBeNull();
    });
});

describe('training threat mode', () => {
    it('models a null move by flipping the turn and clearing en passant', () => {
        const threatFen = threatModeFen(
            'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
        );
        expect(threatFen?.split(' ')).toEqual([
            'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR',
            'w',
            'KQkq',
            '-',
            '1',
            '2',
        ]);
    });

    it('disables null moves in check or after the game has ended', () => {
        expect(
            threatModeFen('4k3/8/8/8/8/8/4R3/4K3 b - - 0 1')
        ).toBeNull();
        expect(
            threatModeFen('7k/5Q2/7K/8/8/8/8/8 b - - 0 1')
        ).toBeNull();
    });
});

describe('White-POV engine presentation', () => {
    it('uses positive for White and negative for Black regardless of turn', () => {
        expect(engineScoreForWhite({ type: 'cp', value: 75 }, START)).toEqual({
            type: 'cp',
            value: 75,
        });
        expect(
            engineScoreForWhite({ type: 'cp', value: 75 }, AFTER_E4)
        ).toEqual({ type: 'cp', value: -75 });
        expect(
            engineWdlForWhite({ win: 700, draw: 200, loss: 100 }, AFTER_E4)
        ).toEqual({ win: 100, draw: 200, loss: 700 });
        expect(
            formatEngineScoreForWhite({ type: 'cp', value: 75 }, START)
        ).toBe('+0.75');
        expect(
            formatEngineScoreForWhite({ type: 'mate', value: 3 }, AFTER_E4)
        ).toBe('#−3');
        expect(
            formatEngineWdlForWhite(
                { win: 700, draw: 200, loss: 100 },
                AFTER_E4
            )
        ).toBe('W 10% · D 20% · L 70%');
        expect(
            whiteExpectedScore({
                score: { type: 'cp', value: 0 },
                wdl: { win: 700, draw: 200, loss: 100 },
                fen: AFTER_E4,
            })
        ).toBeCloseTo(0.2);
    });
});
