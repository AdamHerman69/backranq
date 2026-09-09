import { Chess } from 'chess.js';
import { hash } from './io';
import type { Corpus } from './types';
import type { Job } from './records';

/** A predeclared, exhaustive set of changed decisions. No population sampling weights. */
export function selectedAuditJobs(value: unknown, corpus: Corpus): Job[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid selected audit plan');
    const plan = value as Record<string, unknown>;
    if (plan.version !== 1 || Object.keys(plan).some(k => !['version', 'selections'].includes(k))
        || !Array.isArray(plan.selections) || !plan.selections.length) throw new Error('Invalid selected audit plan');
    const seen = new Set<string>();
    return plan.selections.map((raw: unknown): Job => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid audit selection');
        const selection = raw as Record<string, unknown>;
        if (Object.keys(selection).some(k => !['gameIndex', 'sourceHash', 'plies'].includes(k))
            || !Number.isSafeInteger(selection.gameIndex)) throw new Error('Invalid audit selection');
        const gameIndex = selection.gameIndex as number;
        const game = corpus.games[gameIndex];
        if (!game || game.split !== 'development' || selection.sourceHash !== game.sourceHash) throw new Error('Audit source mismatch or holdout');
        if (!Array.isArray(selection.plies) || !selection.plies.length || selection.plies.length > 12) throw new Error('Audit selection requires 1–12 plies');
        const board = new Chess(); board.loadPgn(game.game.pgn);
        const moves = board.history({ verbose: true });
        const side = game.game.provenance?.userSide;
        if (side !== 'white' && side !== 'black') throw new Error('Missing audit source side');
        const auditPlies = selection.plies.map((ply: unknown) => {
            if (!Number.isSafeInteger(ply) || (ply as number) < 0 || moves[ply as number]?.color !== (side === 'white' ? 'w' : 'b')) throw new Error('Invalid player ply for audit');
            const key = `${gameIndex}:${ply}`;
            if (seen.has(key)) throw new Error('Duplicate audit position');
            seen.add(key);
            if (seen.size > 64) throw new Error('Selected audit exceeds 64-position budget');
            return ply as number;
        }).sort((a, b) => a - b);
        const fields = { kind: 'REFERENCE' as const, gameIndex, profileId: 'SELECTED_AUDIT', auditPlies };
        return { ...fields, id: hash(JSON.stringify(fields)).slice(0, 24) };
    });
}
