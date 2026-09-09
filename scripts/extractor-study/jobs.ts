import type { Corpus, StudyConfig } from './types';
import type { Attempt, Job } from './records';
import { hash } from './io';

export function makeJob(kind: Job['kind'], gameIndex: number, profileId: string, ply?: number, moveUci?: string): Job {
    const fields = { kind, gameIndex, profileId, ...(ply == null ? {} : { ply }), ...(moveUci ? { moveUci } : {}) };
    return { id: hash(JSON.stringify(fields)).slice(0, 24), ...fields };
}
/** Only randomized whole-game audits may contribute population weights or challenges. */
export function isPopulationReference(job: Job): boolean {
    return job.kind === 'REFERENCE' && job.profileId === 'REFERENCE' && job.auditPlies === undefined;
}

export function productJobs(config: StudyConfig, corpus: Corpus, split: 'development' | 'holdout', winner?: string): Job[] {
    if (split === 'holdout' && !winner) throw new Error('Freeze a winner before evaluating holdout accounts.');
    const selected = split === 'development' ? config.profiles : config.profiles.filter(p => ['B0', 'B2', winner].includes(p.id));
    if (split === 'holdout' && !selected.some(p => p.id === winner)) throw new Error('Frozen winner is not configured');
    const jobs: Job[] = [];
    for (const [index, item] of corpus.games.entries()) {
        if (item.split !== split) continue;
        const offset = parseInt(hash(`${config.seed}:${item.game.id}`).slice(0, 8), 16) % selected.length;
        for (let p = 0; p < selected.length; p++) jobs.push(makeJob('PRODUCT', index, selected[(p + offset) % selected.length].id));
        if (config.reference.enabled) jobs.push(makeJob('REFERENCE', index, 'REFERENCE'));
    }
    return jobs;
}
export function spent(attempts: Attempt[]) {
    return attempts.reduce((sum, a) => ({ nodes: sum.nodes + a.meter.requestedNodes, cpu: sum.cpu + a.meter.cpuSeconds }), { nodes: 0, cpu: 0 });
}
