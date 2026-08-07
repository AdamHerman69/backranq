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
    personal: PersonalSearchState;
    handoff: 'HIDDEN' | 'ARMED' | 'OFFERED';
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
    | { type: 'MASTER_TERMINAL' }
    | { type: 'ACCEPT_HANDOFF' }
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
                handoff: 'HIDDEN',
            };
        case 'ANALYSIS_PROGRESS':
            if (
                state.personal.status === 'IDLE' ||
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
                },
            };
        case 'PERSONAL_READY':
            if (
                state.personal.status === 'IDLE' ||
                state.personal.runId !== event.runId
            ) {
                return state;
            }
            return {
                ...state,
                personal: {
                    status: 'READY',
                    runId: event.runId,
                    identity: state.personal.identity,
                    puzzle: event.puzzle,
                },
                handoff: state.masterTerminal ? 'OFFERED' : 'ARMED',
            };
        case 'SEARCH_EMPTY':
            if (
                state.personal.status === 'IDLE' ||
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
                handoff: 'HIDDEN',
            };
        case 'SEARCH_FAILED':
            if (
                state.personal.status === 'IDLE' ||
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
                handoff: 'HIDDEN',
            };
        case 'MASTER_TERMINAL':
            return {
                ...state,
                masterTerminal: true,
                handoff: state.handoff === 'ARMED' ? 'OFFERED' : state.handoff,
            };
        case 'ACCEPT_HANDOFF':
            if (state.personal.status !== 'READY') return state;
            return {
                ...state,
                activePuzzle: state.personal.puzzle,
                masterTerminal: false,
                handoff: 'HIDDEN',
            };
        case 'RESET_MASTER':
            return {
                ...state,
                activePuzzle: event.puzzle,
                masterTerminal: false,
                handoff:
                    state.personal.status === 'READY' ? 'ARMED' : 'HIDDEN',
            };
    }
}
