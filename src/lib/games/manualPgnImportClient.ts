'use client';

import { publishLibraryChanged } from '@/lib/analysis/analysisCompletion';
import { backgroundAnalysis } from '@/lib/analysis/backgroundAnalysisManager';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';

export type ManualPgnImportResponse = {
    created: number;
    duplicates: number;
    createdGameIds: string[];
    duplicateGameIds: string[];
    needsAnalysisGameIds: string[];
};

function isStringArray(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
    );
}

function isManualPgnImportResponse(
    value: unknown
): value is ManualPgnImportResponse {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.created === 'number' &&
        Number.isSafeInteger(record.created) &&
        record.created >= 0 &&
        typeof record.duplicates === 'number' &&
        Number.isSafeInteger(record.duplicates) &&
        record.duplicates >= 0 &&
        isStringArray(record.createdGameIds) &&
        isStringArray(record.duplicateGameIds) &&
        isStringArray(record.needsAnalysisGameIds)
    );
}

function responseError(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const error = (value as { error?: unknown }).error;
    return typeof error === 'string' ? error.trim().slice(0, 300) : '';
}

export async function importManualPgnGames(args: {
    ownerId: string;
    pgn: string;
    playerName: string;
}): Promise<ManualPgnImportResponse> {
    const response = await fetch('/api/games/import', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            [EXPECTED_OWNER_HEADER]: args.ownerId,
        },
        body: JSON.stringify({ pgn: args.pgn, playerName: args.playerName }),
    });
    const result = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
        throw new Error(
            responseError(result) || 'The PGN could not be imported.'
        );
    }
    if (!isManualPgnImportResponse(result)) {
        throw new Error('The PGN import returned an invalid response.');
    }
    return result;
}

export async function importManualPgnGamesAndAnalyze(args: {
    ownerId: string;
    pgn: string;
    playerName: string;
    analyze: boolean;
}): Promise<ManualPgnImportResponse> {
    const result = await importManualPgnGames(args);
    publishLibraryChanged(args.ownerId, { invalidateCompletion: true });
    if (args.analyze && result.needsAnalysisGameIds.length > 0) {
        backgroundAnalysis.setOwner(args.ownerId);
        backgroundAnalysis.enqueueGameDbIds(
            args.ownerId,
            result.needsAnalysisGameIds
        );
    }
    return result;
}
