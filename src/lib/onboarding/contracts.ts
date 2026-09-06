import type { TrainingPromptDto } from '@/lib/training/api';
import type { NormalizedGame } from '@/lib/types/game';

export type PublicChessProvider = 'lichess' | 'chesscom';

export type PublicChessIdentity = {
    provider: PublicChessProvider;
    username: string;
};

export type OnboardingGameDto = Pick<
    NormalizedGame,
    | 'id'
    | 'provider'
    | 'url'
    | 'playedAt'
    | 'timeClass'
    | 'rated'
    | 'white'
    | 'black'
    | 'result'
    | 'termination'
    | 'pgn'
    | 'provenance'
>;

export type OnboardingGamesResponse = {
    requestId: string;
    identity: PublicChessIdentity;
    games: OnboardingGameDto[];
};

export type LandingPuzzleKind = 'MASTER' | 'PERSONAL' | 'WARMUP';

export type LandingPuzzleDto = {
    id: string;
    prompt: TrainingPromptDto;
    context: {
        kind: LandingPuzzleKind;
        headline: string;
        teaser?: string;
        attributionLabel?: string;
        sourceUrl: string | null;
        playedAt: string | null;
        whiteName?: string;
        blackName?: string;
    };
};

export type OnboardingScanPreview = {
    gameId: string;
    fen: string;
    previousFen?: string;
    orientation: 'white' | 'black';
    whiteName: string;
    blackName: string;
    playedAt: string;
};

export type OnboardingAnalysisProgress = {
    /** Identity of the shared extraction invocation; the search also has an outer run ID. */
    runId?: string;
    phase: 'ENGINE_STARTING' | 'SCANNING' | 'CONFIRMING';
    gameIndex: number;
    gameCount: number;
    ply: number;
    plyCount: number;
    preview?: OnboardingScanPreview;
};

export type OnboardingSearchError =
    | 'INVALID_USERNAME'
    | 'PROFILE_NOT_FOUND'
    | 'NO_GAMES'
    | 'NO_VERIFIED_POSITION'
    | 'PROVIDER_RATE_LIMITED'
    | 'PROVIDER_UNAVAILABLE'
    | 'ENGINE_UNAVAILABLE'
    | 'OFFLINE'
    | 'UNKNOWN';
