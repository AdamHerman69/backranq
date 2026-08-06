import { Chess } from 'chess.js';

import type { AttemptGrade } from '@/lib/training/contracts';
import type {
    TrainingPromptDto,
    TrainingReviewDto,
} from '@/lib/training/api';

export type PostMoveStoryKind =
    | 'YOUR_MOVE'
    | 'GAME_LINE'
    | 'BEST_LINE';

export type PostMoveStoryFrame = {
    fen: string;
    moveUci: string | null;
};

export type PostMoveStorySegment = {
    id: string;
    kind: PostMoveStoryKind;
    label: string;
    startFen: string;
    movesUci: string[];
    frames: PostMoveStoryFrame[];
    evidence: 'PRECOMPUTED';
};

export type PostMoveStory = {
    promptKey: string;
    grade: AttemptGrade | null;
    segments: PostMoveStorySegment[];
};

function normalizeUci(value: string | null | undefined): string | null {
    const normalized = value?.trim().toLowerCase() ?? '';
    return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(normalized)
        ? normalized
        : null;
}

export function storyFrames(
    startFen: string,
    movesUci: readonly string[]
): PostMoveStoryFrame[] {
    let chess: Chess;
    try {
        chess = new Chess(startFen);
    } catch {
        return [];
    }
    const frames: PostMoveStoryFrame[] = [
        { fen: chess.fen(), moveUci: null },
    ];
    for (const rawMove of movesUci.slice(0, 64)) {
        const moveUci = normalizeUci(rawMove);
        if (!moveUci) break;
        try {
            const move = chess.move({
                from: moveUci.slice(0, 2),
                to: moveUci.slice(2, 4),
                promotion: moveUci.slice(4, 5) || undefined,
            });
            if (!move) break;
            frames.push({ fen: chess.fen(), moveUci });
        } catch {
            break;
        }
    }
    return frames;
}

function segment(args: {
    id: string;
    kind: PostMoveStoryKind;
    label: string;
    startFen: string;
    movesUci: readonly string[];
}): PostMoveStorySegment | null {
    const movesUci = args.movesUci
        .map(normalizeUci)
        .filter((move): move is string => Boolean(move));
    if (movesUci.length === 0) return null;
    const frames = storyFrames(args.startFen, movesUci);
    if (frames.length !== movesUci.length + 1) return null;
    return {
        id: args.id,
        kind: args.kind,
        label: args.label,
        startFen: frames[0]!.fen,
        movesUci,
        frames,
        evidence: 'PRECOMPUTED',
    };
}

export function buildPostMoveStory(args: {
    prompt: TrainingPromptDto;
    review: TrainingReviewDto;
    grade: AttemptGrade | null;
}): PostMoveStory {
    const candidates = [
        segment({
            id: 'your-move',
            kind: 'YOUR_MOVE',
            label: 'Your move',
            startFen: args.prompt.fen,
            movesUci: args.review.submittedMoveUci
                ? [args.review.submittedMoveUci]
                : [],
        }),
        segment({
            id: 'game-line',
            kind: 'GAME_LINE',
            label: 'Move from the game',
            startFen: args.prompt.fen,
            movesUci: [args.review.originalMoveUci],
        }),
        segment({
            id: 'best-line',
            kind: 'BEST_LINE',
            label: 'Best continuation',
            startFen: args.prompt.fen,
            movesUci: args.review.bestLineUci,
        }),
    ].filter(
        (candidate): candidate is PostMoveStorySegment => Boolean(candidate)
    );

    return {
        promptKey: `${args.prompt.id}:${args.prompt.solutionRevisionId}`,
        grade: args.grade,
        segments: candidates,
    };
}
