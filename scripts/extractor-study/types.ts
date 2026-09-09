import type { NormalizedGame } from '@/lib/types/game';
import type { StockfishEngine, Score, EngineWdl } from '@/lib/analysis/stockfishClient';

export type Profile = {
    id: string;
    mode: 'THOROUGH' | 'STANDARD' | 'SINGLE' | 'POINT' | 'WINDOW';
    scanNodes: number;
    rootMultiPv: number;
    additional: 'CURRENT' | 'NONE' | 'PAIR_ONCE' | 'ADAPTIVE' | 'TARGETED' | 'TARGETED_V2' | 'TARGETED_PRIORITY';
    rounds: number[];
    postScanGameNodes: number;
    postScanCandidateNodes: number;
};
export type StudyConfig = {
    version: 1;
    seed: string;
    month: string;
    outputDirectory: string;
    discovery: {
        seedAccounts: string[];
        maxAccounts: number;
        maxRequests: number;
        requestDelayMs: number;
        accountsPerBucket: number;
        developmentAccountsPerBucket: number;
        gamesPerAccount: number;
        minPlies: number;
        maxPlies: number;
        ratingEdges: number[];
    };
    profiles: Profile[];
    limits: {
        globalNodes: number;
        globalCpuSeconds: number;
        perJobNodes: number;
        perJobSeconds: number;
    };
    reference: { enabled: boolean; scanNodes: number; rootNodes: number; moveNodes: number; positionsPerGame: number };
};
export type StudyGame = {
    game: NormalizedGame;
    account: string;
    rating: number;
    bucket: number;
    split: 'development' | 'holdout';
    sourceHash: string;
};
export type Corpus = {
    version: 1;
    configHash: string;
    samplingDescription: string;
    games: StudyGame[];
    accounts: Array<{ username: string; rating: number; bucket: number; split: 'development' | 'holdout' }>;
    exclusions: Record<string, number>;
    complete: boolean;
};
export type StudyDecision = {
    ply: number;
    originalMoveUci: string;
    preferredMoveUci: string | null;
    candidate: boolean;
    admitted: boolean;
    reason: string;
    estimate: 'GOOD' | 'BELOW_STANDARD' | 'UNKNOWN';
    lossCp: number | null;
    lossExpectedScore: number | null;
    referenceScore: Score | null;
    originalScore: Score | null;
    referenceWdl?: EngineWdl;
    originalWdl?: EngineWdl;
    comparisonBasis: 'SAME_ROOT' | 'PARENT_CHILD_SCAN' | 'PRODUCT_POLICY';
    evidenceIds: string[];
    targetedVerification?: {
        triggers: Array<'WDL_LOW_CP' | 'WDL_ONLY' | 'SCAN_ACCEPTANCE_DISAGREEMENT' | 'SEMANTIC_CONFLICT'>;
        outcome: 'NOT_TRIGGERED' | 'VERIFIED' | 'UNRESOLVED' | 'SKIPPED_BUDGET' | 'INVALID_VERIFICATION';
        requestedNodes: number;
        searchIds: string[];
        scanSnapshotIds: string[];
        initial: Pick<StudyDecision, 'admitted' | 'estimate' | 'reason' | 'lossCp' | 'lossExpectedScore'>;
    };
};
export type StrategyResult = {
    decisions: StudyDecision[];
    // Experimental admissions are research records, never certified production moments.
    productMoments: unknown[];
    errors: string[];
};
export type StrategyInput = {
    game: StudyGame;
    profile: Profile;
    engine: StockfishEngine;
    signal?: AbortSignal;
};

export type AuditSample = {
    ply: number;
    stratum: 'ADMITTED' | 'CANDIDATE' | 'OTHER';
    population: number;
    inclusionProbability: number;
    decision: StudyDecision;
    strictQuality: 'GOOD' | 'BELOW_STANDARD' | 'UNKNOWN';
    alternatives: Array<{ moveUci: string; estimate: 'GOOD' | 'BELOW_STANDARD' | 'UNKNOWN' }>;
};
export type ReferenceResult = {
    samples: AuditSample[];
    scanCandidates: number[];
    errors: string[];
};
