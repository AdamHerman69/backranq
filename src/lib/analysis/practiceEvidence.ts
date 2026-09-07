import type { AnalysisSnapshot, EngineIdentity, Score, SearchEvidence } from './stockfishClient';
import { analysisEngineFingerprint } from './positionAnalysisPool';
import {
    practiceContextId,
    practiceFingerprint,
    type AnalysisObservation,
    type EvidenceStore,
    type PracticeScore,
    type SearchReason,
    type SearchRecord,
    type Side,
} from '@/lib/training/practiceContract';

export function practiceEngineFingerprint(engine: EngineIdentity): string {
    return practiceFingerprint(analysisEngineFingerprint(engine));
}

export function practiceScoreFromEngine(score: Score, rootSide: Side): PracticeScore {
    if (score.type === 'cp') return { kind: 'CP', cp: score.value, pov: rootSide };
    return {
        kind: 'MATE', plies: Math.abs(score.value) * 2 - (score.value > 0 ? 1 : 0),
        winner: score.value > 0 ? rootSide : rootSide === 'WHITE' ? 'BLACK' : 'WHITE',
        pov: rootSide,
    };
}

function reasonForSearch(purpose: string): SearchReason {
    if (purpose.includes('SCAN')) return 'SCAN';
    if (purpose.includes('COVERAGE')) return 'OPTIONAL_COVERAGE';
    if (purpose.includes('CONTINUATION')) return 'CONTINUATION';
    if (purpose.includes('DRIFT')) return 'REFERENCE_DRIFT';
    if (purpose.includes('UNSTABLE')) return 'UNSTABLE_QUALITY';
    if (purpose === 'VERIFY_REFERENCE') return 'VERIFY_REFERENCE';
    if (purpose.includes('REFERENCE')) return 'MISSING_REFERENCE';
    return 'MISSING_MOVE';
}

/** Translate native point iterations and directional counters without inventing convergence. */
export function practiceEvidenceFromSnapshots(
    snapshots: readonly AnalysisSnapshot[],
    trainingSide: Side,
    completedSearches: readonly SearchEvidence[] = [],
): EvidenceStore {
    const evidence: EvidenceStore = { searches: {}, observations: {}, exact: {} };
    const finals = new Map(completedSearches.map(search => [search.id, search]));
    for (const snapshot of snapshots) {
        const native = snapshot.searchEvidence;
        if (native.source !== 'ENGINE' || !snapshot.lines.length) continue;
        const contextId = practiceContextId(native.request.fen, native.request.previousFens, trainingSide);
        const fingerprint = practiceEngineFingerprint(native.engine);
        const rootSide: Side = native.request.fen.split(/\s+/)[1] === 'w' ? 'WHITE' : 'BLACK';
        const lines: AnalysisObservation['lines'] = [];
        for (const line of snapshot.lines) {
            if (!line.score || !line.pvUci.length || line.depth !== snapshot.depth) continue;
            const bound = snapshot.bundleComplete ? 'UNBOUNDED'
                : 'bound' in line && (line.bound === 'UPPER' || line.bound === 'LOWER') ? line.bound : null;
            if (!bound) continue;
            lines.push({
                moveUci: line.pvUci[0]!, score: practiceScoreFromEngine(line.score, rootSide),
                bound, wdl: snapshot.bundleComplete ? line.wdl ?? null : null, pvUci: [...line.pvUci],
            });
        }
        if (lines.length !== snapshot.lines.length) continue;
        const observation: AnalysisObservation = {
            id: snapshot.id, searchId: snapshot.searchId, snapshotIndex: snapshot.snapshotIndex,
            contextId, engineFingerprint: fingerprint, rootScopeUci: [...native.request.rootMoves].sort(),
            requestedMultiPv: native.request.multiPv, completedSlots: lines.length,
            bundleComplete: snapshot.bundleComplete, depth: snapshot.depth,
            nodes: native.reported.nodes, elapsedMs: native.reported.timeMs, lines,
        };
        evidence.observations[observation.id] = observation;
        let search = evidence.searches[snapshot.searchId];
        if (!search) {
            const final = finals.get(snapshot.searchId);
            const source: SearchRecord['engineIdentity']['source'] = /browser/i.test(native.engine.source)
                ? 'CLIENT_ENGINE' : 'SERVER_ENGINE';
            search = {
                id: snapshot.searchId, contextId, sequence: Object.keys(evidence.searches).length,
                engineIdentity: {
                    fingerprint, artifactId: native.engine.artifactId, name: native.engine.name, build: native.engine.version ?? native.engine.flavor ?? 'unknown',
                    nnue: native.engine.evalFile ?? 'bundled', options: { ...native.engine.options },
                    wdlModel: native.engine.options.UCI_ShowWDL === false ? null : native.engine.version ?? native.engine.name,
                    source,
                },
                // No adapter session identifier is invented: search identity is a conservative boundary.
                sessionId: native.sessionId ?? snapshot.searchId,
                request: {
                    fen: native.request.fen, positionHistory: [...native.request.previousFens], trainingSide,
                    rootScopeUci: [...native.request.rootMoves].sort(), multiPv: native.request.multiPv,
                    limit: { nodes: native.request.limits.nodes ?? null, depth: native.request.limits.depth ?? null,
                        movetimeMs: native.request.limits.movetimeMs ?? null },
                },
                reason: reasonForSearch(native.request.purpose),
                reportedNodes: final?.reported.nodes ?? native.reported.nodes,
                reportedTimeMs: final?.reported.timeMs ?? native.reported.timeMs,
                completion: final ? 'COMPLETED' : 'STOPPED', observationIds: [],
            };
            evidence.searches[search.id] = search;
        }
        search.reportedNodes = Math.max(search.reportedNodes, observation.nodes);
        search.reportedTimeMs = Math.max(search.reportedTimeMs, observation.elapsedMs);
        if (!search.observationIds.includes(observation.id)) search.observationIds.push(observation.id);
    }
    return evidence;
}

export function mergePracticeEvidence(...stores: readonly EvidenceStore[]): EvidenceStore {
    const merged: EvidenceStore = { searches: {}, observations: {}, exact: {} };
    for (const [storeIndex, store] of stores.entries()) {
        Object.assign(merged.observations, store.observations);
        Object.assign(merged.exact, store.exact);
        // Dictionary order is not chronology (notably after JSONB persistence).
        // The first store is immutable; later physical searches retain their
        // explicit relative order while being appended after existing records.
        for (const search of Object.values(store.searches).sort((a, b) => a.sequence - b.sequence)) {
            const prior = merged.searches[search.id];
            merged.searches[search.id] = prior ? {
                ...search, sequence: prior.sequence,
                completion: prior.completion === 'COMPLETED' ? prior.completion : search.completion,
                reportedNodes: Math.max(prior.reportedNodes, search.reportedNodes),
                reportedTimeMs: Math.max(prior.reportedTimeMs, search.reportedTimeMs),
                observationIds: [...new Set([...prior.observationIds, ...search.observationIds])],
            } : { ...structuredClone(search), sequence: storeIndex === 0 ? search.sequence
                : Math.max(-1, ...Object.values(merged.searches).map(s => s.sequence)) + 1 };
        }
    }
    return merged;
}
