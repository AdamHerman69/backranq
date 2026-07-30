import { Chess, type Square } from 'chess.js';

import { parseUci } from '@/lib/chess/utils';
import type {
    CoachPlayedMove,
    CoachResumablePhase,
    CoachSessionSnapshot,
} from '@/lib/coach/types';
import { normalizeCoachThresholdCp } from '@/lib/coach/verification';
import { OPPONENT_PROFILE_IDS } from '@/lib/coach/profiles';
import type {
    MultiPvResult,
    Score,
} from '@/lib/analysis/stockfishClient';
import type { CoachMistake } from '@/lib/coach/types';

const DATABASE_NAME = 'backranq-coach';
const DATABASE_VERSION = 1;
const STORE_NAME = 'coach-sessions';
const ACTIVE_SESSION_KEY = 'active';
const SNAPSHOT_VERSION = 1;
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const EXACT_UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

type StoredCoachSession = {
    key: typeof ACTIVE_SESSION_KEY;
    snapshot: CoachSessionSnapshot;
};

function openDatabase(): Promise<IDBDatabase | null> {
    if (typeof window === 'undefined' || !window.indexedDB) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        let settled = false;
        const request = window.indexedDB.open(
            DATABASE_NAME,
            DATABASE_VERSION
        );
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => {
            if (settled) {
                request.result.close();
                return;
            }
            settled = true;
            resolve(request.result);
        };
        request.onerror = () => {
            settled = true;
            resolve(null);
        };
        request.onblocked = () => {
            if (!settled) {
                settled = true;
                resolve(null);
            }
        };
    });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T | null> {
    return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

function isResumablePhase(value: unknown): value is CoachResumablePhase {
    return (
        value === 'preparing' ||
        value === 'player' ||
        value === 'checking' ||
        value === 'confirming' ||
        value === 'bot' ||
        value === 'mistake'
    );
}

function replayMoves(
    candidateMoves: unknown,
    userColor: 'w' | 'b'
): {
    chess: Chess;
    moves: CoachPlayedMove[];
    positionFens: string[];
} | null {
    if (!Array.isArray(candidateMoves) || candidateMoves.length > 512) {
        return null;
    }
    const chess = new Chess();
    const positionFens = [chess.fen()];
    const moves: CoachPlayedMove[] = [];
    for (let ply = 0; ply < candidateMoves.length; ply += 1) {
        const candidate = candidateMoves[ply] as
            | Partial<CoachPlayedMove>
            | null;
        if (!candidate || typeof candidate.uci !== 'string') return null;
        const normalizedUci = candidate.uci.trim().toLowerCase();
        if (!EXACT_UCI_RE.test(normalizedUci)) return null;
        const parsed = parseUci(normalizedUci);
        if (!parsed) return null;
        const expectedActor =
            chess.turn() === userColor ? 'player' : 'bot';
        if (candidate.actor !== expectedActor) return null;
        const fenBefore = chess.fen();
        let played;
        try {
            played = chess.move({
                from: parsed.from,
                to: parsed.to,
                promotion: parsed.promotion,
            });
        } catch {
            return null;
        }
        if (!played) return null;
        const canonical: CoachPlayedMove = {
            ply,
            actor: expectedActor,
            san: played.san,
            uci: normalizedUci,
            fenBefore,
            fenAfter: chess.fen(),
            from: played.from as Square,
            to: played.to as Square,
        };
        moves.push(canonical);
        positionFens.push(canonical.fenAfter);
    }
    return { chess, moves, positionFens };
}

function isScore(value: unknown): value is Score {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<Score>;
    return (
        (candidate.type === 'cp' || candidate.type === 'mate') &&
        typeof candidate.value === 'number' &&
        Number.isFinite(candidate.value)
    );
}

function isMultiPvResult(value: unknown): value is MultiPvResult {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<MultiPvResult>;
    return (
        typeof candidate.fen === 'string' &&
        typeof candidate.bestMoveUci === 'string' &&
        Array.isArray(candidate.lines) &&
        candidate.lines.length >= 1 &&
        candidate.lines.length <= 8 &&
        candidate.lines.every(
            (line) =>
                line &&
                Number.isSafeInteger(line.multipv) &&
                line.multipv >= 1 &&
                line.multipv <= 8 &&
                Array.isArray(line.pvUci) &&
                line.pvUci.length <= 256 &&
                (line.score == null || isScore(line.score))
        )
    );
}

function isCoachMistake(value: unknown): value is CoachMistake {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<CoachMistake>;
    return (
        typeof candidate.id === 'string' &&
        candidate.id.length > 0 &&
        candidate.id.length <= 256 &&
        Number.isSafeInteger(candidate.decisionPly) &&
        typeof candidate.decisionFen === 'string' &&
        typeof candidate.fenAfterMove === 'string' &&
        typeof candidate.moveUci === 'string' &&
        EXACT_UCI_RE.test(candidate.moveUci) &&
        typeof candidate.moveSan === 'string' &&
        typeof candidate.bestMoveUci === 'string' &&
        Array.isArray(candidate.bestLineUci) &&
        candidate.bestLineUci.length <= 256 &&
        isMultiPvResult(candidate.beforeAnalysis) &&
        (candidate.afterAnalysis == null ||
            isMultiPvResult(candidate.afterAnalysis)) &&
        candidate.afterEvaluation != null &&
        typeof candidate.afterEvaluation === 'object' &&
        candidate.assessment != null &&
        typeof candidate.assessment === 'object' &&
        candidate.assessment.loss != null &&
        typeof candidate.assessment.loss === 'object' &&
        typeof candidate.assessment.shouldIntervene === 'boolean' &&
        candidate.verification != null &&
        typeof candidate.verification === 'object' &&
        typeof candidate.verification.confirmationRan === 'boolean' &&
        typeof candidate.verification.stable === 'boolean' &&
        typeof candidate.verification.interventionConfirmed === 'boolean'
    );
}

export function sanitizeCoachSessionSnapshot(
    value: unknown,
    now = Date.now()
): CoachSessionSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    try {
        if (JSON.stringify(value).length > 2_000_000) return null;
    } catch {
        return null;
    }
    const candidate = value as Partial<CoachSessionSnapshot>;
    if (
        candidate.version !== SNAPSHOT_VERSION ||
        typeof candidate.sessionKey !== 'string' ||
        !candidate.sessionKey ||
        typeof candidate.ownerId !== 'string' ||
        !candidate.ownerId ||
        candidate.ownerId.length > 256 ||
        typeof candidate.savedAt !== 'number' ||
        !Number.isFinite(candidate.savedAt) ||
        now - candidate.savedAt > MAX_SESSION_AGE_MS ||
        candidate.savedAt > now + 60_000 ||
        !isResumablePhase(candidate.phase) ||
        (candidate.userColor !== 'w' && candidate.userColor !== 'b') ||
        !OPPONENT_PROFILE_IDS.includes(
            candidate.opponentId as (typeof OPPONENT_PROFILE_IDS)[number]
        )
    ) {
        return null;
    }
    const replayed = replayMoves(candidate.moves, candidate.userColor);
    if (!replayed || replayed.chess.fen() !== candidate.gameFen) return null;
    const currentTurn = replayed.chess.turn();
    const pendingDecision =
        candidate.pendingDecision &&
        typeof candidate.pendingDecision === 'object' &&
        isMultiPvResult(candidate.pendingDecision.beforeAnalysis) &&
        candidate.pendingDecision.beforeAnalysis.fen ===
            candidate.pendingDecision.record?.fenBefore &&
        candidate.pendingDecision.record?.uci ===
            replayed.moves.at(-1)?.uci
            ? {
                  record: replayed.moves.at(-1)!,
                  beforeAnalysis:
                      candidate.pendingDecision.beforeAnalysis,
              }
            : null;
    const mistake = isCoachMistake(candidate.mistake)
        ? candidate.mistake
        : null;
    const mistakes =
        Array.isArray(candidate.mistakes) &&
        candidate.mistakes.length <= 128 &&
        candidate.mistakes.every(isCoachMistake)
            ? candidate.mistakes
            : null;
    if (!mistakes) return null;
    const lastMove = replayed.moves.at(-1) ?? null;
    const baseline =
        candidate.baseline == null
            ? null
            : isMultiPvResult(candidate.baseline) &&
                candidate.baseline.fen === replayed.chess.fen()
              ? candidate.baseline
              : undefined;
    if (baseline === undefined) return null;
    if (
        mistake &&
        (!lastMove ||
            mistake.decisionPly !== lastMove.ply ||
            mistake.decisionFen !== lastMove.fenBefore ||
            mistake.fenAfterMove !== lastMove.fenAfter ||
            mistake.moveUci !== lastMove.uci ||
            mistake.beforeAnalysis.fen !== lastMove.fenBefore)
    ) {
        return null;
    }
    if (
        ((candidate.phase === 'player' ||
            candidate.phase === 'preparing') &&
            currentTurn !== candidate.userColor) ||
        (candidate.phase === 'bot' &&
            currentTurn === candidate.userColor) ||
        ((candidate.phase === 'checking' ||
            candidate.phase === 'confirming') &&
            (!pendingDecision ||
                currentTurn === candidate.userColor)) ||
        (candidate.phase === 'mistake' &&
            (!mistake || currentTurn === candidate.userColor))
    ) {
        return null;
    }

    return {
        version: SNAPSHOT_VERSION,
        sessionKey: candidate.sessionKey,
        ownerId: candidate.ownerId,
        savedAt: candidate.savedAt,
        phase: candidate.phase,
        userColor: candidate.userColor,
        opponentId: candidate.opponentId!,
        thresholdCp: normalizeCoachThresholdCp(candidate.thresholdCp),
        gameFen: replayed.chess.fen(),
        moves: replayed.moves,
        positionFens: replayed.positionFens,
        baseline,
        pendingDecision,
        mistake,
        mistakes,
        flipped: candidate.flipped === true,
    };
}

export async function loadCoachSession(
    expectedOwnerId?: string
): Promise<CoachSessionSnapshot | null> {
    const database = await openDatabase();
    if (!database) return null;
    try {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const record = await requestResult(
            transaction
                .objectStore(STORE_NAME)
                .get(ACTIVE_SESSION_KEY) as IDBRequest<StoredCoachSession>
        );
        const snapshot = sanitizeCoachSessionSnapshot(record?.snapshot);
        if (
            snapshot &&
            expectedOwnerId &&
            snapshot.ownerId !== expectedOwnerId
        ) {
            return null;
        }
        return snapshot;
    } catch {
        return null;
    } finally {
        database.close();
    }
}

export async function saveCoachSession(
    snapshot: CoachSessionSnapshot
): Promise<boolean> {
    const sanitized = sanitizeCoachSessionSnapshot(snapshot);
    if (!sanitized) return false;
    const database = await openDatabase();
    if (!database) return false;
    try {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put({
            key: ACTIVE_SESSION_KEY,
            snapshot: sanitized,
        } satisfies StoredCoachSession);
        await transactionComplete(transaction);
        return true;
    } catch {
        return false;
    } finally {
        database.close();
    }
}

export async function clearCoachSession(): Promise<void> {
    const database = await openDatabase();
    if (!database) return;
    try {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(ACTIVE_SESSION_KEY);
        await transactionComplete(transaction);
    } catch {
        // Local recovery is best-effort and must never block the game.
    } finally {
        database.close();
    }
}
