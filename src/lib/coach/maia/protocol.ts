import type { MaiaLegalMove } from '@/lib/coach/maia/preprocess';
import type {
    MaiaEngineStatus,
    MaiaErrorCode,
    MaiaMoveResult,
} from '@/lib/coach/maia/types';

export type MaiaWorkerRequest =
    | {
          type: 'initialize';
          id: string;
          allowDownload: boolean;
      }
    | {
          type: 'select-move';
          id: string;
          tokens: Float32Array;
          legalMoves: MaiaLegalMove[];
          selfElo: number;
          opponentElo: number;
          seed: number;
      };

export type MaiaSerializedError = {
    code: MaiaErrorCode;
    message: string;
    recoverable: boolean;
};

export type MaiaWorkerResponse =
    | {
          type: 'status';
          requestId: string | null;
          status: MaiaEngineStatus;
      }
    | {
          type: 'initialized';
          id: string;
          status: MaiaEngineStatus;
      }
    | {
          type: 'move';
          id: string;
          result: MaiaMoveResult;
      }
    | {
          type: 'error';
          id: string | null;
          error: MaiaSerializedError;
          status: MaiaEngineStatus;
      };
