import { originalDecisionForPracticeManifest, practiceProfileMatchesConfig } from './practiceSourceBinding';
import { Chess } from 'chess.js';
import { isStrictIsoInstant } from '@/lib/api/validation';
import { isGameSource, type GameSource } from '@/lib/types/game';
import { moveToUci } from '@/lib/chess/utils';
import { hashSourcePgn, sourcePgnPositionFens } from '@/lib/chess/pgn';
import {
    TRAINING_LESSON_KINDS, TRAINING_SOURCE_KINDS, stableCanonicalStringify,
    type TrainingMomentCandidate,
} from './contracts';
import { parsePracticeMomentRevision, practiceContextId } from './practiceContract';
import { solutionSemanticsHash } from './contractHashes.server';

const MAX_POSITION_HISTORY = 256;
const MAX_CANDIDATE_JSON_BYTES = 512_000;
const HASH_RE = /^[a-f0-9]{64}$/;
export type TrainingCandidateValidationResult =
    | { ok: true; moments: TrainingMomentCandidate[] }
    | { ok: false; error: string };

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function uniqueStrings(value: unknown, limit: number, allowed?: readonly string[]): value is string[] {
    return Array.isArray(value) && value.length <= limit && new Set(value).size === value.length
        && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 64
            && (!allowed || allowed.includes(item)));
}
function validateCandidate(value: unknown): TrainingMomentCandidate | null {
    try {
        if (!object(value) || new TextEncoder().encode(JSON.stringify(value)).length > MAX_CANDIDATE_JSON_BYTES
            || typeof value.sourceGameId !== 'string' || !value.sourceGameId.trim() || value.sourceGameId.length > 512
            || !isGameSource(value.sourceProvider) || !isStrictIsoInstant(value.sourcePlayedAt)
            || typeof value.sourcePgnHash !== 'string' || !HASH_RE.test(value.sourcePgnHash)
            || !Number.isSafeInteger(value.decisionPly) || Number(value.decisionPly) < 0 || Number(value.decisionPly) > 2047
            || typeof value.fen !== 'string' || !Array.isArray(value.positionHistory) || value.positionHistory.length > MAX_POSITION_HISTORY
            || !value.positionHistory.every(fen => typeof fen === 'string')
            || !uniqueStrings(value.sourceKinds, TRAINING_SOURCE_KINDS.length, TRAINING_SOURCE_KINDS) || !value.sourceKinds.length
            || !uniqueStrings(value.lessonKinds, TRAINING_LESSON_KINDS.length, TRAINING_LESSON_KINDS)
            || !uniqueStrings(value.themes, 64) || !object(value.solution)
            || typeof value.solution.configHash !== 'string' || !HASH_RE.test(value.solution.configHash)) return null;
        const manifest = parsePracticeMomentRevision(value.solution.manifest);
        const side = manifest.source.trainingSide === 'WHITE' ? 'w' : 'b';
        const source = manifest.source;
        if (source.gameId !== value.sourceGameId || source.sourcePgnHash !== value.sourcePgnHash
            || source.decisionPly !== value.decisionPly || source.fen !== value.fen
            || source.originalMoveUci !== value.originalMoveUci || value.sideToMove !== side
            || new Chess(value.fen).turn() !== side
            || stableCanonicalStringify(source.positionHistory) !== stableCanonicalStringify(value.positionHistory)
            || source.contextId !== practiceContextId(source.fen, source.positionHistory, source.trainingSide)
            || solutionSemanticsHash({ manifest, configHash: value.solution.configHash }) !== manifest.semanticHash
            || stableCanonicalStringify(value.originalDecision) !== stableCanonicalStringify(originalDecisionForPracticeManifest(manifest))
            || (value.phase !== undefined && !['OPENING','MIDDLEGAME','ENDGAME'].includes(String(value.phase)))) return null;
        const candidate = value as unknown as TrainingMomentCandidate;
        return { ...candidate, solution: { manifest, configHash: value.solution.configHash } };
    } catch {
        return null;
    }
}

export function validateTrainingMomentCandidates(value: unknown, maxItems = 2048): TrainingCandidateValidationResult {
    if (!Array.isArray(value) || value.length > maxItems) return { ok: false, error: 'Invalid training moments' };
    const moments: TrainingMomentCandidate[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const candidate = validateCandidate(item);
        if (!candidate) return { ok: false, error: 'Invalid training moments' };
        const key = `${candidate.sourceGameId}\0${candidate.sourcePgnHash}\0${candidate.decisionPly}`;
        if (seen.has(key)) return { ok: false, error: 'Duplicate training decision' };
        seen.add(key);
        moments.push(candidate);
    }
    return { ok: true, moments };
}

export function trainingMomentCandidatesMatchSource(args: {
    moments: TrainingMomentCandidate[];
    gameId: string;
    provider: GameSource;
    playedAt: Date;
    pgn: string;
    configHash: string;
    configSnapshot: unknown;
}): boolean {
    const fens = sourcePgnPositionFens(args.pgn);
    if (!fens) return false;
    const chess = new Chess();
    try {
        chess.loadPgn(args.pgn, { strict: false });
    } catch {
        return false;
    }
    const moves = chess.history({ verbose: true });
    const pgnHash = hashSourcePgn(args.pgn);
    return args.moments.every((moment) => {
        const sourceMove = moves[moment.decisionPly];
        const sourceFen = fens[moment.decisionPly];
        const expectedHistory = fens.slice(
            Math.max(
                0,
                moment.decisionPly - MAX_POSITION_HISTORY
            ),
            moment.decisionPly
        );
        return (
            !!sourceMove &&
            !!sourceFen &&
            moment.sourceGameId === args.gameId &&
            moment.sourceProvider === args.provider &&
            Date.parse(moment.sourcePlayedAt) ===
                args.playedAt.getTime() &&
            moment.sourcePgnHash === pgnHash &&
            moment.fen === sourceFen &&
            stableCanonicalStringify(
                moment.positionHistory
            ) === stableCanonicalStringify(expectedHistory) &&
            moment.sideToMove === sourceFen.split(/\s+/)[1] &&
            moment.originalMoveUci ===
                moveToUci(sourceMove).toLowerCase() &&
            moment.solution.configHash === args.configHash &&
            practiceProfileMatchesConfig(moment.solution.manifest, args.configHash, args.configSnapshot)
        );
    });
}
