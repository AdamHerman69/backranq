import type { ExtractionCompletionManifest } from './extractTrainingMoments';
import { decisionAssessment } from '@/lib/training/evidenceContract';

/** One current completion contract for browser saves and server transactions. */
export function isCompleteExtractionManifest(value: unknown): value is ExtractionCompletionManifest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const manifest = value as Record<string, unknown>;
    if (manifest.version !== 1 || manifest.complete !== true ||
        manifest.scanComplete !== true || manifest.extractionComplete !== true ||
        manifest.scope !== 'FULL_GAME' || manifest.termination !== 'COMPLETED' ||
        typeof manifest.sourceGameId !== 'string' || !manifest.sourceGameId ||
        typeof manifest.sourcePgnHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sourcePgnHash) ||
        !Number.isSafeInteger(manifest.expectedPlies) ||
        (manifest.expectedPlies as number) < 0 || (manifest.expectedPlies as number) > 2048 ||
        manifest.scannedPlies !== manifest.expectedPlies ||
        !Array.isArray(manifest.errors) || manifest.errors.length !== 0 ||
        !Array.isArray(manifest.decisionOutcomes) || manifest.decisionOutcomes.length > 2048) return false;
    const seen = new Set<number>();
    for (const raw of manifest.decisionOutcomes) {
        if (!raw || typeof raw !== 'object' || !decisionAssessment(raw)) return false;
        const ply = (raw as { decisionPly: number }).decisionPly;
        if (!Number.isSafeInteger(ply) || ply < 0 || ply >= (manifest.expectedPlies as number) || seen.has(ply)) return false;
        seen.add(ply);
    }
    return true;
}
