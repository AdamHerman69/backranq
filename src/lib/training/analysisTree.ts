import { Chess } from 'chess.js';

import { moveToUci, parseUci } from '@/lib/chess/utils';

export const TRAINING_ANALYSIS_TREE_VERSION = 1;
export const TRAINING_ANALYSIS_TREE_MAX_NODES = 2_048;

export type TrainingAnalysisNodeTag =
    | 'SOURCE_GAME'
    | 'DECISION'
    | 'YOUR_MOVE'
    | 'GAME_MOVE'
    | 'BEST_LINE'
    | 'ANALYSIS';

export type TrainingAnalysisPositionContext =
    | 'source'
    | 'decision'
    | 'analysis';

export type TrainingAnalysisNode = {
    id: string;
    parentId: string | null;
    fen: string;
    moveUci: string | null;
    moveSan: string | null;
    childrenIds: string[];
    tags: TrainingAnalysisNodeTag[];
};

export type TrainingAnalysisTree = {
    version: typeof TRAINING_ANALYSIS_TREE_VERSION;
    rootId: string;
    cursorId: string;
    decisionNodeId: string;
    submittedMoveNodeId: string | null;
    gameMoveNodeId: string | null;
    bestLineNodeId: string | null;
    selectedChildByNode: Record<string, string>;
    nodes: Record<string, TrainingAnalysisNode>;
    nextNodeSequence: number;
};

type SeedMoveTag = Exclude<
    TrainingAnalysisNodeTag,
    'SOURCE_GAME' | 'DECISION' | 'ANALYSIS'
>;

const NODE_TAGS = new Set<TrainingAnalysisNodeTag>([
    'SOURCE_GAME',
    'DECISION',
    'YOUR_MOVE',
    'GAME_MOVE',
    'BEST_LINE',
    'ANALYSIS',
]);

function canonicalFen(fen: string): string | null {
    try {
        return new Chess(fen).fen();
    } catch {
        return null;
    }
}

function positionKey(fen: string): string {
    return fen.split(' ').slice(0, 4).join(' ');
}

function normalizeUci(moveUci: string | null | undefined): string | null {
    const value = moveUci?.trim().toLowerCase() ?? '';
    return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value) ? value : null;
}

function uniqueTags(
    tags: readonly TrainingAnalysisNodeTag[]
): TrainingAnalysisNodeTag[] {
    return Array.from(new Set(tags));
}

function applyMove(fen: string, moveUci: string) {
    const move = parseUci(moveUci);
    if (!move) return null;
    try {
        const chess = new Chess(fen);
        const played = chess.move({
            from: move.from,
            to: move.to,
            promotion: move.promotion,
        });
        if (!played) return null;
        return {
            fen: chess.fen(),
            moveUci: moveToUci(played).toLowerCase(),
            moveSan: played.san,
        };
    } catch {
        return null;
    }
}

function moveBetweenFens(fromFen: string, toFen: string) {
    const target = positionKey(toFen);
    try {
        const chess = new Chess(fromFen);
        for (const candidate of chess.moves({ verbose: true })) {
            const next = new Chess(fromFen);
            const played = next.move({
                from: candidate.from,
                to: candidate.to,
                promotion: candidate.promotion,
            });
            if (played && positionKey(next.fen()) === target) {
                return {
                    fen: next.fen(),
                    moveUci: moveToUci(played).toLowerCase(),
                    moveSan: played.san,
                };
            }
        }
    } catch {
        return null;
    }
    return null;
}

function normalizedSourcePositions(
    positionHistory: readonly string[],
    decisionFen: string
): string[] {
    const decision = canonicalFen(decisionFen);
    if (!decision) return [];

    const positions: string[] = [];
    for (const rawFen of [...positionHistory.slice(-256), decision]) {
        const fen = canonicalFen(rawFen);
        if (!fen || positionKey(positions.at(-1) ?? '') === positionKey(fen)) {
            continue;
        }
        positions.push(fen);
    }
    return positions;
}

function mutableAddMove(
    tree: TrainingAnalysisTree,
    parentId: string,
    moveUci: string,
    tags: readonly TrainingAnalysisNodeTag[],
    makeMainLine: boolean
): string | null {
    const parent = tree.nodes[parentId];
    const normalizedMove = normalizeUci(moveUci);
    if (!parent || !normalizedMove) return null;

    const existingId = parent.childrenIds.find(
        (childId) => tree.nodes[childId]?.moveUci === normalizedMove
    );
    if (existingId) {
        const existing = tree.nodes[existingId]!;
        existing.tags = uniqueTags([...existing.tags, ...tags]);
        if (makeMainLine && parent.childrenIds[0] !== existingId) {
            parent.childrenIds = [
                existingId,
                ...parent.childrenIds.filter((id) => id !== existingId),
            ];
        }
        tree.selectedChildByNode[parentId] = existingId;
        return existingId;
    }

    if (Object.keys(tree.nodes).length >= TRAINING_ANALYSIS_TREE_MAX_NODES) {
        return null;
    }
    const applied = applyMove(parent.fen, normalizedMove);
    if (!applied) return null;

    const id = `n${tree.nextNodeSequence}`;
    tree.nextNodeSequence += 1;
    tree.nodes[id] = {
        id,
        parentId,
        fen: applied.fen,
        moveUci: applied.moveUci,
        moveSan: applied.moveSan,
        childrenIds: [],
        tags: uniqueTags(tags),
    };
    parent.childrenIds = makeMainLine
        ? [id, ...parent.childrenIds]
        : [...parent.childrenIds, id];
    tree.selectedChildByNode[parentId] = id;
    return id;
}

function addTaggedLine(
    tree: TrainingAnalysisTree,
    parentId: string,
    moves: readonly string[],
    tag: SeedMoveTag,
    makeFirstMoveMainLine: boolean
): string | null {
    let currentId = parentId;
    let lastId: string | null = null;
    for (const [index, move] of moves.entries()) {
        const nextId = mutableAddMove(
            tree,
            currentId,
            move,
            [tag],
            index === 0 && makeFirstMoveMainLine
        );
        if (!nextId) break;
        currentId = nextId;
        lastId = nextId;
    }
    return lastId;
}

function matchingNodeId(
    tree: TrainingAnalysisTree,
    fen: string | null | undefined
): string | null {
    const normalized = fen ? canonicalFen(fen) : null;
    if (!normalized) return null;
    const key = positionKey(normalized);
    const preferred = [
        tree.submittedMoveNodeId,
        tree.gameMoveNodeId,
        tree.bestLineNodeId,
        tree.decisionNodeId,
    ];
    for (const id of preferred) {
        if (id && positionKey(tree.nodes[id]?.fen ?? '') === key) return id;
    }
    return (
        Object.values(tree.nodes).find(
            (node) => positionKey(node.fen) === key
        )?.id ?? null
    );
}

export function createTrainingAnalysisTree(args: {
    decisionFen: string;
    positionHistory: readonly string[];
    originalMoveUci?: string | null;
    submittedMoveUci?: string | null;
    bestLineUci?: readonly string[];
    initialFen?: string | null;
}): TrainingAnalysisTree {
    const decisionFen = canonicalFen(args.decisionFen);
    if (!decisionFen) {
        throw new Error('Cannot create an analysis tree from an invalid FEN.');
    }

    const candidates = normalizedSourcePositions(
        args.positionHistory,
        decisionFen
    );
    const sourceMoves = candidates.slice(0, -1).map((fen, index) => {
        const nextFen = candidates[index + 1];
        return nextFen ? moveBetweenFens(fen, nextFen) : null;
    });
    const hasCompleteSource =
        candidates.length > 0 &&
        sourceMoves.every((move) => move !== null);
    const sourcePositions = hasCompleteSource ? candidates : [decisionFen];
    const rootFen = sourcePositions[0] ?? decisionFen;
    const root: TrainingAnalysisNode = {
        id: 'n0',
        parentId: null,
        fen: rootFen,
        moveUci: null,
        moveSan: null,
        childrenIds: [],
        tags: sourcePositions.length > 1 ? ['SOURCE_GAME'] : ['DECISION'],
    };
    const tree: TrainingAnalysisTree = {
        version: TRAINING_ANALYSIS_TREE_VERSION,
        rootId: root.id,
        cursorId: root.id,
        decisionNodeId: root.id,
        submittedMoveNodeId: null,
        gameMoveNodeId: null,
        bestLineNodeId: null,
        selectedChildByNode: {},
        nodes: { [root.id]: root },
        nextNodeSequence: 1,
    };

    let decisionNodeId = root.id;
    if (sourcePositions.length > 1) {
        for (const sourceMove of sourceMoves) {
            if (!sourceMove) break;
            const nextId = mutableAddMove(
                tree,
                decisionNodeId,
                sourceMove.moveUci,
                ['SOURCE_GAME'],
                true
            );
            if (!nextId) break;
            decisionNodeId = nextId;
        }
    }
    tree.decisionNodeId = decisionNodeId;
    tree.nodes[decisionNodeId]!.tags = uniqueTags([
        ...tree.nodes[decisionNodeId]!.tags,
        'DECISION',
    ]);

    const originalMove = normalizeUci(args.originalMoveUci);
    if (originalMove) {
        tree.gameMoveNodeId = addTaggedLine(
            tree,
            decisionNodeId,
            [originalMove],
            'GAME_MOVE',
            true
        );
    }

    const submittedMove = normalizeUci(args.submittedMoveUci);
    if (submittedMove) {
        tree.submittedMoveNodeId = addTaggedLine(
            tree,
            decisionNodeId,
            [submittedMove],
            'YOUR_MOVE',
            !tree.gameMoveNodeId
        );
    }

    const bestLine = (args.bestLineUci ?? [])
        .map(normalizeUci)
        .filter((move): move is string => move !== null)
        .slice(0, 64);
    if (bestLine.length > 0) {
        tree.bestLineNodeId = addTaggedLine(
            tree,
            decisionNodeId,
            bestLine,
            'BEST_LINE',
            !tree.gameMoveNodeId && !tree.submittedMoveNodeId
        );
    }

    tree.selectedChildByNode = Object.fromEntries(
        Object.values(tree.nodes).flatMap((node) =>
            node.childrenIds[0] ? [[node.id, node.childrenIds[0]]] : []
        )
    );
    const initialCursorId =
        matchingNodeId(tree, args.initialFen) ?? tree.decisionNodeId;
    tree.cursorId = tree.decisionNodeId;
    return jumpToTrainingAnalysisNode(tree, initialCursorId);
}

function withCursor(
    tree: TrainingAnalysisTree,
    cursorId: string
): TrainingAnalysisTree {
    if (!tree.nodes[cursorId] || tree.cursorId === cursorId) return tree;
    const selectedChildByNode = { ...tree.selectedChildByNode };
    const seen = new Set<string>();
    let childId = cursorId;
    while (!seen.has(childId)) {
        seen.add(childId);
        const parentId = tree.nodes[childId]?.parentId;
        if (!parentId) break;
        selectedChildByNode[parentId] = childId;
        childId = parentId;
    }
    return { ...tree, cursorId, selectedChildByNode };
}

export function jumpToTrainingAnalysisNode(
    tree: TrainingAnalysisTree,
    nodeId: string
): TrainingAnalysisTree {
    return withCursor(tree, nodeId);
}

export function playTrainingAnalysisMove(
    tree: TrainingAnalysisTree,
    moveUci: string
): TrainingAnalysisTree {
    const next: TrainingAnalysisTree = structuredClone(tree);
    const childId = mutableAddMove(
        next,
        next.cursorId,
        moveUci,
        ['ANALYSIS'],
        false
    );
    if (!childId) return tree;
    next.cursorId = childId;
    return next;
}

export function previousTrainingAnalysisNode(
    tree: TrainingAnalysisTree
): TrainingAnalysisTree {
    const parentId = tree.nodes[tree.cursorId]?.parentId;
    return parentId ? withCursor(tree, parentId) : tree;
}

export function nextTrainingAnalysisNode(
    tree: TrainingAnalysisTree
): TrainingAnalysisTree {
    const cursor = tree.nodes[tree.cursorId];
    if (!cursor || cursor.childrenIds.length === 0) return tree;
    const selectedId = tree.selectedChildByNode[cursor.id];
    const childId =
        selectedId && cursor.childrenIds.includes(selectedId)
            ? selectedId
            : cursor.childrenIds[0]!;
    return withCursor(tree, childId);
}

export function firstTrainingAnalysisNode(
    tree: TrainingAnalysisTree
): TrainingAnalysisTree {
    return withCursor(tree, tree.rootId);
}

export function lastTrainingAnalysisNode(
    tree: TrainingAnalysisTree
): TrainingAnalysisTree {
    let nodeId = tree.cursorId;
    const seen = new Set<string>();
    while (!seen.has(nodeId)) {
        seen.add(nodeId);
        const node = tree.nodes[nodeId];
        if (!node || node.childrenIds.length === 0) break;
        const selectedId = tree.selectedChildByNode[nodeId];
        nodeId =
            selectedId && node.childrenIds.includes(selectedId)
                ? selectedId
                : node.childrenIds[0]!;
    }
    return withCursor(tree, nodeId);
}

export function siblingTrainingAnalysisNode(
    tree: TrainingAnalysisTree,
    direction: -1 | 1
): TrainingAnalysisTree {
    const cursor = tree.nodes[tree.cursorId];
    const parent = cursor?.parentId ? tree.nodes[cursor.parentId] : null;
    if (!cursor || !parent || parent.childrenIds.length < 2) return tree;
    const index = parent.childrenIds.indexOf(cursor.id);
    if (index < 0) return tree;
    const nextIndex =
        (index + direction + parent.childrenIds.length) %
        parent.childrenIds.length;
    return withCursor(tree, parent.childrenIds[nextIndex]!);
}

export function promoteTrainingAnalysisVariation(
    tree: TrainingAnalysisTree,
    nodeId: string
): TrainingAnalysisTree {
    const node = tree.nodes[nodeId];
    const parent = node?.parentId ? tree.nodes[node.parentId] : null;
    if (!node || !parent || parent.childrenIds[0] === nodeId) return tree;
    return {
        ...tree,
        selectedChildByNode: {
            ...tree.selectedChildByNode,
            [parent.id]: nodeId,
        },
        nodes: {
            ...tree.nodes,
            [parent.id]: {
                ...parent,
                childrenIds: [
                    nodeId,
                    ...parent.childrenIds.filter((id) => id !== nodeId),
                ],
            },
        },
    };
}

function protectedAnalysisNode(node: TrainingAnalysisNode): boolean {
    return node.tags.some((tag) => tag !== 'ANALYSIS');
}

export function canDeleteTrainingAnalysisVariation(
    tree: TrainingAnalysisTree,
    nodeId: string
): boolean {
    return deletableTrainingAnalysisNodeIds(tree).has(nodeId);
}

export function deletableTrainingAnalysisNodeIds(
    tree: TrainingAnalysisTree
): Set<string> {
    const deletable = new Set<string>();
    const stack: Array<{ id: string; visited: boolean }> = [
        { id: tree.rootId, visited: false },
    ];
    while (stack.length > 0) {
        const entry = stack.pop()!;
        const node = tree.nodes[entry.id];
        if (!node) continue;
        if (!entry.visited) {
            stack.push({ id: node.id, visited: true });
            for (const childId of node.childrenIds) {
                stack.push({ id: childId, visited: false });
            }
            continue;
        }
        if (
            node.parentId &&
            !protectedAnalysisNode(node) &&
            node.childrenIds.every((childId) => deletable.has(childId))
        ) {
            deletable.add(node.id);
        }
    }
    return deletable;
}

export function deleteTrainingAnalysisVariation(
    tree: TrainingAnalysisTree,
    nodeId: string
): TrainingAnalysisTree {
    if (!canDeleteTrainingAnalysisVariation(tree, nodeId)) return tree;
    const node = tree.nodes[nodeId]!;
    const parent = tree.nodes[node.parentId!]!;
    const deletedIds = new Set<string>();
    const pending = [nodeId];
    while (pending.length > 0) {
        const currentId = pending.pop()!;
        const current = tree.nodes[currentId];
        if (!current || deletedIds.has(currentId)) continue;
        deletedIds.add(currentId);
        pending.push(...current.childrenIds);
    }

    const nodes = { ...tree.nodes };
    const selectedChildByNode = { ...tree.selectedChildByNode };
    for (const deletedId of deletedIds) {
        delete nodes[deletedId];
        delete selectedChildByNode[deletedId];
    }
    const childrenIds = parent.childrenIds.filter(
        (childId) => !deletedIds.has(childId)
    );
    nodes[parent.id] = { ...parent, childrenIds };
    if (deletedIds.has(selectedChildByNode[parent.id] ?? '')) {
        if (childrenIds[0]) selectedChildByNode[parent.id] = childrenIds[0];
        else delete selectedChildByNode[parent.id];
    }
    return {
        ...tree,
        cursorId: deletedIds.has(tree.cursorId) ? parent.id : tree.cursorId,
        nodes,
        selectedChildByNode,
    };
}

export function trainingAnalysisPath(
    tree: TrainingAnalysisTree,
    nodeId = tree.cursorId
): TrainingAnalysisNode[] {
    const path: TrainingAnalysisNode[] = [];
    const seen = new Set<string>();
    let currentId: string | null = nodeId;
    while (currentId && !seen.has(currentId)) {
        seen.add(currentId);
        const node: TrainingAnalysisNode | undefined =
            tree.nodes[currentId];
        if (!node) return [];
        path.push(node);
        currentId = node.parentId;
    }
    return path.reverse();
}

export function trainingAnalysisPly(node: TrainingAnalysisNode): number {
    const parts = node.fen.split(' ');
    const fullmove = Math.max(1, Math.trunc(Number(parts[5]) || 1));
    return (fullmove - 1) * 2 + (parts[1] === 'b' ? 1 : 0);
}

export function trainingAnalysisPositionContext(
    tree: TrainingAnalysisTree,
    nodeId = tree.cursorId
): TrainingAnalysisPositionContext {
    const node = tree.nodes[nodeId];
    if (!node || node.id === tree.decisionNodeId) return 'decision';
    return node.tags.includes('SOURCE_GAME') ||
        node.tags.includes('GAME_MOVE')
        ? 'source'
        : 'analysis';
}

export function trainingAnalysisAnchorNodes(
    tree: TrainingAnalysisTree
): Array<{ id: string; label: string }> {
    const candidates = [
        { id: tree.decisionNodeId, label: 'Decision position' },
        tree.submittedMoveNodeId
            ? { id: tree.submittedMoveNodeId, label: 'After your move' }
            : null,
        tree.gameMoveNodeId
            ? { id: tree.gameMoveNodeId, label: 'After the game move' }
            : null,
        tree.bestLineNodeId
            ? { id: tree.bestLineNodeId, label: 'End of best line' }
            : null,
    ].filter((anchor): anchor is { id: string; label: string } =>
        Boolean(anchor)
    );
    const seen = new Set<string>();
    return candidates.filter((anchor) => {
        if (seen.has(anchor.id)) return false;
        seen.add(anchor.id);
        return true;
    });
}

export function threatModeFen(fen: string): string | null {
    try {
        const chess = new Chess(fen);
        if (chess.isCheck() || chess.isGameOver()) return null;
        const parts = chess.fen().split(' ');
        const turn = parts[1] === 'b' ? 'b' : 'w';
        parts[1] = turn === 'w' ? 'b' : 'w';
        parts[3] = '-';
        parts[4] = String(Math.max(0, Math.trunc(Number(parts[4]) || 0)) + 1);
        if (turn === 'b') {
            parts[5] = String(
                Math.max(1, Math.trunc(Number(parts[5]) || 1)) + 1
            );
        }
        return parts.join(' ');
    } catch {
        return null;
    }
}

function stringOrNull(value: unknown): string | null | undefined {
    return value === null
        ? null
        : typeof value === 'string'
          ? value
          : undefined;
}

export function sanitizeTrainingAnalysisTree(
    value: unknown,
    decisionFen: string
): TrainingAnalysisTree | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (raw.version !== TRAINING_ANALYSIS_TREE_VERSION) return null;
    if (!raw.nodes || typeof raw.nodes !== 'object') return null;
    const rawNodes = raw.nodes as Record<string, unknown>;
    const entries = Object.entries(rawNodes);
    if (
        entries.length === 0 ||
        entries.length > TRAINING_ANALYSIS_TREE_MAX_NODES
    ) {
        return null;
    }

    const nodes: Record<string, TrainingAnalysisNode> = {};
    for (const [id, rawNode] of entries) {
        if (
            !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
            !rawNode ||
            typeof rawNode !== 'object'
        ) {
            return null;
        }
        const candidate = rawNode as Record<string, unknown>;
        const parentId = stringOrNull(candidate.parentId);
        const moveUci = stringOrNull(candidate.moveUci);
        const moveSan = stringOrNull(candidate.moveSan);
        const fen =
            typeof candidate.fen === 'string'
                ? canonicalFen(candidate.fen)
                : null;
        if (
            parentId === undefined ||
            moveUci === undefined ||
            moveSan === undefined ||
            !fen ||
            !Array.isArray(candidate.childrenIds) ||
            !candidate.childrenIds.every(
                (childId) =>
                    typeof childId === 'string' && childId.length <= 64
            ) ||
            new Set(candidate.childrenIds).size !==
                candidate.childrenIds.length ||
            !Array.isArray(candidate.tags) ||
            !candidate.tags.every(
                (tag): tag is TrainingAnalysisNodeTag =>
                    typeof tag === 'string' &&
                    NODE_TAGS.has(tag as TrainingAnalysisNodeTag)
            )
        ) {
            return null;
        }
        nodes[id] = {
            id,
            parentId,
            fen,
            moveUci,
            moveSan,
            childrenIds: [...candidate.childrenIds],
            tags: uniqueTags(candidate.tags),
        };
    }

    const rootId = stringOrNull(raw.rootId);
    const cursorId = stringOrNull(raw.cursorId);
    const decisionNodeId = stringOrNull(raw.decisionNodeId);
    const submittedMoveNodeId = stringOrNull(raw.submittedMoveNodeId);
    const gameMoveNodeId = stringOrNull(raw.gameMoveNodeId);
    const bestLineNodeId = stringOrNull(raw.bestLineNodeId);
    if (
        !rootId ||
        !cursorId ||
        !decisionNodeId ||
        submittedMoveNodeId === undefined ||
        gameMoveNodeId === undefined ||
        bestLineNodeId === undefined ||
        !nodes[rootId] ||
        !nodes[cursorId] ||
        !nodes[decisionNodeId] ||
        (submittedMoveNodeId !== null && !nodes[submittedMoveNodeId]) ||
        (gameMoveNodeId !== null && !nodes[gameMoveNodeId]) ||
        (bestLineNodeId !== null && !nodes[bestLineNodeId]) ||
        nodes[rootId].parentId !== null ||
        positionKey(nodes[decisionNodeId].fen) !==
            positionKey(canonicalFen(decisionFen) ?? '')
    ) {
        return null;
    }

    for (const node of Object.values(nodes)) {
        if (node.id !== rootId && (!node.parentId || !nodes[node.parentId])) {
            return null;
        }
        if (
            node.childrenIds.some(
                (childId) => nodes[childId]?.parentId !== node.id
            )
        ) {
            return null;
        }
        if (node.parentId) {
            const parent = nodes[node.parentId];
            if (!parent.childrenIds.includes(node.id)) return null;
            const applied = node.moveUci
                ? applyMove(parent.fen, node.moveUci)
                : null;
            if (
                !applied ||
                positionKey(applied.fen) !== positionKey(node.fen) ||
                applied.moveSan !== node.moveSan
            ) {
                return null;
            }
        } else if (node.moveUci !== null || node.moveSan !== null) {
            return null;
        }
    }

    const reachable = new Set<string>();
    const pending = [rootId];
    while (pending.length > 0) {
        const id = pending.pop()!;
        if (reachable.has(id)) return null;
        reachable.add(id);
        pending.push(...nodes[id]!.childrenIds);
    }
    if (reachable.size !== entries.length) return null;

    const selectedChildByNode: Record<string, string> = {};
    if (raw.selectedChildByNode && typeof raw.selectedChildByNode === 'object') {
        for (const [parentId, childId] of Object.entries(
            raw.selectedChildByNode as Record<string, unknown>
        )) {
            if (
                typeof childId === 'string' &&
                nodes[parentId]?.childrenIds.includes(childId)
            ) {
                selectedChildByNode[parentId] = childId;
            }
        }
    }
    const largestNodeSequence = entries.reduce((largest, [id]) => {
        const match = /^n(\d+)$/.exec(id);
        return match
            ? Math.max(largest, Math.trunc(Number(match[1]) || 0))
            : largest;
    }, 0);
    const nextNodeSequence = Math.max(
        largestNodeSequence + 1,
        entries.length
    );
    return {
        version: TRAINING_ANALYSIS_TREE_VERSION,
        rootId,
        cursorId,
        decisionNodeId,
        submittedMoveNodeId,
        gameMoveNodeId,
        bestLineNodeId,
        selectedChildByNode,
        nodes,
        nextNodeSequence,
    };
}
