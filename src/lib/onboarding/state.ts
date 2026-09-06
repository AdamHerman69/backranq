import type {
    LandingPuzzleDto,
    OnboardingAnalysisProgress,
    OnboardingSearchError,
    PublicChessIdentity,
} from './contracts';

export type PersonalSearchState =
    | { status: 'IDLE' }
    | { status: 'FETCHING'; runId: string; identity: PublicChessIdentity }
    | {
          status: 'ANALYZING';
          runId: string;
          identity: PublicChessIdentity;
          progress: OnboardingAnalysisProgress;
          animationMs: number;
      }
    | {
          status: 'READY';
          runId: string;
          identity: PublicChessIdentity;
          puzzle: LandingPuzzleDto;
      }
    | {
          status: 'EMPTY';
          runId: string;
          identity: PublicChessIdentity;
          reason: 'NO_GAMES' | 'NO_VERIFIED_POSITION';
      }
    | {
          status: 'ERROR';
          runId: string;
          identity: PublicChessIdentity;
          reason: OnboardingSearchError;
          retryable: boolean;
      };

export type LandingOnboardingState = {
    activePuzzle: LandingPuzzleDto;
    masterTerminal: boolean;
    activePuzzleInteracted: boolean;
    personal: PersonalSearchState;
};

export type LandingOnboardingEvent =
    | { type: 'SEARCH_STARTED'; runId: string; identity: PublicChessIdentity }
    | {
          type: 'ANALYSIS_PROGRESS';
          runId: string;
          progress: OnboardingAnalysisProgress;
      }
    | { type: 'PERSONAL_READY'; runId: string; puzzle: LandingPuzzleDto }
    | {
          type: 'SEARCH_EMPTY';
          runId: string;
          reason: 'NO_GAMES' | 'NO_VERIFIED_POSITION';
      }
    | {
          type: 'SEARCH_FAILED';
          runId: string;
          reason: OnboardingSearchError;
          retryable: boolean;
      }
    | { type: 'PUZZLE_INTERACTED'; puzzleId: string }
    | { type: 'MASTER_TERMINAL' }
    | { type: 'RESET_MASTER'; puzzle: LandingPuzzleDto };

export function landingOnboardingReducer(
    state: LandingOnboardingState,
    event: LandingOnboardingEvent
): LandingOnboardingState {
    switch (event.type) {
        case 'SEARCH_STARTED':
            return {
                ...state,
                personal: {
                    status: 'FETCHING',
                    runId: event.runId,
                    identity: event.identity,
                },
            };
        case 'ANALYSIS_PROGRESS':
            if (
                (state.personal.status !== 'FETCHING' && state.personal.status !== 'ANALYZING') ||
                state.personal.runId !== event.runId
            ) {
                return state;
            }
            return {
                ...state,
                personal: {
                    status: 'ANALYZING',
                    runId: event.runId,
                    identity: state.personal.identity,
                    progress: event.progress,
                    animationMs:
                        state.personal.status === 'ANALYZING' &&
                        event.progress.preview !== undefined &&
                        state.personal.progress.phase === 'SCANNING' &&
                        event.progress.phase === 'SCANNING' &&
                        state.personal.progress.preview?.gameId === event.progress.preview?.gameId &&
                        state.personal.progress.ply + 1 === event.progress.ply &&
                        state.personal.progress.preview?.fen === event.progress.preview?.previousFen
                            ? 100 : 0,
                },
            };
        case 'PERSONAL_READY': {
            if (
                (state.personal.status !== 'FETCHING' && state.personal.status !== 'ANALYZING') ||
                state.personal.runId !== event.runId
            ) {
                return state;
            }
            return {
                ...state,
                activePuzzle: event.puzzle,
                activePuzzleInteracted: false,
                masterTerminal: false,
                personal: {
                    status: 'READY',
                    runId: event.runId,
                    identity: state.personal.identity,
                    puzzle: event.puzzle,
                },
            };
        }
        case 'SEARCH_EMPTY':
            if (
                (state.personal.status !== 'FETCHING' && state.personal.status !== 'ANALYZING') ||
                state.personal.runId !== event.runId
            ) {
                return state;
            }
            return {
                ...state,
                personal: {
                    status: 'EMPTY',
                    runId: event.runId,
                    identity: state.personal.identity,
                    reason: event.reason,
                },
            };
        case 'SEARCH_FAILED':
            if (
                (state.personal.status !== 'FETCHING' && state.personal.status !== 'ANALYZING') ||
                state.personal.runId !== event.runId
            ) {
                return state;
            }
            return {
                ...state,
                personal: {
                    status: 'ERROR',
                    runId: event.runId,
                    identity: state.personal.identity,
                    reason: event.reason,
                    retryable: event.retryable,
                },
            };
        case 'PUZZLE_INTERACTED':
            if ((state.personal.status !== 'IDLE' && state.personal.status !== 'READY') || event.puzzleId !== state.activePuzzle.id) return state;
            return { ...state, activePuzzleInteracted: true };
        case 'MASTER_TERMINAL':
            return {
                ...state,
                masterTerminal: true,
            };
        case 'RESET_MASTER':
            if (state.personal.status !== 'IDLE' || state.activePuzzleInteracted) {
                return state;
            }
            return {
                ...state,
                activePuzzle: event.puzzle,
                masterTerminal: false,
            };
    }
}
