import type { Corpus, Profile, ReferenceResult, StrategyResult, StudyConfig } from './types';

export type Job = {
    id: string;
    kind: 'PRODUCT' | 'REFERENCE' | 'ANSWER';
    /** Exhaustive explicit audit subset, never a random whole-game reference sample. */
    auditPlies?: number[];
    gameIndex: number;
    profileId: string;
    ply?: number;
    moveUci?: string;
};
export type Meter = {
    requestedNodes: number;
    reportedNodes: number;
    reportedEngineMs: number;
    queries: number;
    physicalSearches: number;
    cpuSeconds: number;
    wallMs: number;
    maxRssBytes: number;
};
export type Attempt = {
    fingerprint: string;
    job: Job;
    attempt: number;
    state: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CENSORED';
    startedAt: string;
    meter: Meter;
    error?: string;
    nodeAllowance: number;
    cpuAllowance: number;
    workerPid?: number;
    host?: string;
};
export type AnswerResult = {
    ply: number;
    moveUci: string;
    knownBefore: boolean;
    profileAdmitted: boolean;
    quality: 'GOOD' | 'BELOW_STANDARD' | 'UNKNOWN';
    referenceEstimate: 'GOOD' | 'BELOW_STANDARD' | 'UNKNOWN';
    updates: unknown[];
    error?: string;
};
export type JobResult = {
    fingerprint: string;
    job: Job;
    state: Attempt['state'];
    meter: Meter;
    strategy?: StrategyResult;
    reference?: ReferenceResult;
    answer?: AnswerResult;
    poolFile?: string;
    error?: string;
};
export type FrozenRun = {
    fingerprint: string;
    configHash: string;
    corpusHash: string;
    bundleHash: string;
    engineFiles: Record<string, string>;
    createdAt: string;
    nodeVersion: string;
    platform: string;
    cpu: string;
};
export type WorkerInput = {
    directory: string;
    journalPath: string;
    resultPath: string;
    fingerprint: string;
    config: StudyConfig;
    corpus: Corpus;
    job: Job;
    profile?: Profile;
    attempt: number;
    nodeAllowance: number;
    cpuAllowance: number;
};
