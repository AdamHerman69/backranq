import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, jsonFiles, readJson } from './io';
import { isPopulationReference, productJobs, spent } from './jobs';
import type { Attempt, FrozenRun, JobResult } from './records';
import type { Corpus, StudyConfig } from './types';

const ratio = (n: number, d: number) => d ? n / d : null;
function csv(value: unknown): string {
    let text = value == null ? '' : String(value);
    if (typeof value === 'string' && /^[=+@-]/.test(text)) text = `'${text}`;
    return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export function summarize(config: StudyConfig, corpus: Corpus, results: JobResult[], attempts: Attempt[]) {
    const rows = [];
    const accounts = [];
    const buckets = [];
    for (const split of ['development', 'holdout'] as const) {
        for (const profile of config.profiles) {
            const product = results.filter(r => r.job.kind === 'PRODUCT' && r.job.profileId === profile.id && corpus.games[r.job.gameIndex]?.split === split);
            if (!product.length) continue;
            const complete = product.filter(r => r.state === 'COMPLETED');
            const productAttempts = attempts.filter(a => a.job.kind === 'PRODUCT' && a.job.profileId === profile.id && corpus.games[a.job.gameIndex]?.split === split);
            const decisions = complete.flatMap(r => r.strategy?.decisions ?? []);
            const admissionCount = decisions.filter(d => d.admitted).length;
            let sampledAdmitted = 0, sampledGoodOriginal = 0, sampledUnknown = 0;
            let admittedWeight = 0, falseWeight = 0, unknownWeight = 0, usefulWeight = 0, retainedWeight = 0;
            for (const r of complete) {
                const reference = results.find(q => isPopulationReference(q.job) && q.job.gameIndex === r.job.gameIndex && q.state === 'COMPLETED');
                for (const sample of reference?.reference?.samples ?? []) {
                    if (!(sample.inclusionProbability > 0 && sample.inclusionProbability <= 1)) throw new Error('Invalid reference inclusion probability');
                    const d = r.strategy?.decisions.find(d => d.ply === sample.ply);
                    const weight = 1 / sample.inclusionProbability;
                    if (sample.decision.admitted) { usefulWeight += weight; if (d?.admitted) retainedWeight += weight; }
                    if (!d?.admitted) continue;
                    sampledAdmitted++; admittedWeight += weight;
                    if (sample.decision.estimate === 'GOOD') { sampledGoodOriginal++; falseWeight += weight; }
                    if (sample.decision.estimate === 'UNKNOWN') { sampledUnknown++; unknownWeight += weight; }
                }
            }
            const answers = results.filter(r => r.job.kind === 'ANSWER' && r.job.profileId === profile.id && r.state === 'COMPLETED' && corpus.games[r.job.gameIndex]?.split === split).flatMap(r => r.answer ? [r.answer] : []);
            const refereeGood = answers.filter(a => a.referenceEstimate === 'GOOD');
            const refereeBad = answers.filter(a => a.referenceEstimate === 'BELOW_STANDARD');
            const costs = spent(productAttempts);
            const answerAttempts = attempts.filter(a => a.job.kind === 'ANSWER' && a.job.profileId === profile.id && corpus.games[a.job.gameIndex]?.split === split);
            const row = { split, profile: profile.id, scheduledResultFiles: product.length, completedGames: complete.length,
                failedOrCensoredGames: product.length - complete.length, playerDecisions: decisions.length,
                admitted: admissionCount, certifiedProductMoments: complete.reduce((n, r) => n + (r.strategy?.productMoments.length ?? 0), 0),
                gamesWithAdmission: complete.filter(r => r.strategy?.decisions.some(d => d.admitted)).length,
                productAttemptNodes: costs.nodes, productAttemptCpuSeconds: costs.cpu,
                cpuPerCompletedGameIncludingRetries: ratio(costs.cpu, complete.length),
                cpuPerAdmittedIncludingRetries: ratio(costs.cpu, admissionCount),
                sampledAdmitted, sampledGoodOriginal, sampledUnknown,
                weightedFalseAdmissionAmongResolved: ratio(falseWeight, admittedWeight - unknownWeight),
                weightedReferenceUnknown: ratio(unknownWeight, admittedWeight),
                falseAdmissionBestCase: ratio(falseWeight, admittedWeight),
                falseAdmissionWorstCase: ratio(falseWeight + unknownWeight, admittedWeight),
                sampledAuditUsefulRecall: ratio(retainedWeight, usefulWeight),
                testedAnswers: answers.length, knownBefore: answers.filter(a => a.knownBefore).length,
                answerUnresolved: answers.filter(a => a.quality === 'UNKNOWN').length,
                answerReferenceUnknown: answers.filter(a => a.referenceEstimate === 'UNKNOWN').length,
                actuallyAdmittedAnswerChallenges: answers.filter(a => a.profileAdmitted).length,
                actuallyAdmittedAnswerUnresolved: answers.filter(a => a.profileAdmitted && a.quality === 'UNKNOWN').length,
                actuallyAdmittedFalseRejections: answers.filter(a => a.profileAdmitted && a.referenceEstimate === 'GOOD' && a.quality === 'BELOW_STANDARD').length,
                actuallyAdmittedFalseAcceptances: answers.filter(a => a.profileAdmitted && a.referenceEstimate === 'BELOW_STANDARD' && a.quality === 'GOOD').length,
                falseRejections: refereeGood.filter(a => a.quality === 'BELOW_STANDARD').length,
                referenceGoodAnswers: refereeGood.length,
                falseAcceptances: refereeBad.filter(a => a.quality === 'GOOD').length,
                referenceBelowAnswers: refereeBad.length,
                answerAttemptNodes: spent(answerAttempts).nodes, answerAttemptCpuSeconds: spent(answerAttempts).cpu };
            rows.push(row);
            for (const account of new Set(complete.map(r => corpus.games[r.job.gameIndex].account))) {
                const games = complete.filter(r => corpus.games[r.job.gameIndex].account === account);
                accounts.push({ split, profile: profile.id, account, games: games.length,
                    rating: corpus.accounts.find(a => a.username === account)?.rating ?? null,
                    bucket: corpus.games[games[0].job.gameIndex].bucket,
                    admitted: games.reduce((n, r) => n + (r.strategy?.decisions.filter(d => d.admitted).length ?? 0), 0),
                    cpuSeconds: games.reduce((n, r) => n + r.meter.cpuSeconds, 0),
                    nodes: games.reduce((n, r) => n + r.meter.requestedNodes, 0) });
            }
            for (let bucket = 0; bucket < config.discovery.ratingEdges.length; bucket++) {
                const games = complete.filter(r => corpus.games[r.job.gameIndex].bucket === bucket);
                const costs = spent(productAttempts.filter(a => corpus.games[a.job.gameIndex].bucket === bucket));
                buckets.push({ split, profile: profile.id, bucket, minRating: config.discovery.ratingEdges[bucket],
                    maxRatingExclusive: config.discovery.ratingEdges[bucket + 1] ?? null,
                    completedGames: games.length, accounts: new Set(games.map(r => corpus.games[r.job.gameIndex].account)).size,
                    admitted: games.reduce((n, r) => n + (r.strategy?.decisions.filter(d => d.admitted).length ?? 0), 0),
                    playerDecisions: games.reduce((n, r) => n + (r.strategy?.decisions.length ?? 0), 0),
                    cpuSecondsIncludingRetries: costs.cpu, nodesIncludingRetries: costs.nodes });
            }
        }
    }
    const selected = results.filter(r => r.job.kind === 'REFERENCE' && r.job.profileId === 'SELECTED_AUDIT');
    const selectedAttempts = attempts.filter(a => a.job.kind === 'REFERENCE' && a.job.profileId === 'SELECTED_AUDIT');
    const selectedCosts = spent(selectedAttempts);
    const selectedAudit = {
        populationEstimate: false,
        resultFiles: selected.length,
        completedJobs: selected.filter(r => r.state === 'COMPLETED').length,
        completedPositions: selected.filter(r => r.state === 'COMPLETED').reduce((n, r) => n + (r.reference?.samples.length ?? 0), 0),
        attemptNodes: selectedCosts.nodes,
        attemptCpuSeconds: selectedCosts.cpu,
    };
    return { version: 1, rows, accounts, buckets, selectedAudit, totalExperiment: spent(attempts),
        failedAttempts: attempts.filter(a => a.state !== 'COMPLETED').length,
        limitations: [
            'Seeded opponent-network sample; not uniform random Chess.com population.',
            'Experimental admissions are research records, not deployed/certified Practice moments.',
            'Strong point and strict projections are finite comparators, not ground truth.',
            'Rates use stratified sampling weights; raw sample counts and unresolved bounds are shown.',
            'Explicit selected audits are excluded from population estimates and standard answer challenges; their counts and costs appear separately.',
            'No statistical release gate is automatically passed; account sample size and uncertainty require review.',
            'CPU includes worker process and engine child telemetry; failed/killed CPU reservations may be conservative estimates. No cloud dollar cost measured.',
            'Answer tests use the real grading function on server WASM, not browser UI or physical mobile latency.',
            'Answers are a fixed challenge set, not observed player move-frequency probabilities.',
            'Common answer challenges include positions a profile did not admit; actual-admission subsets are reported separately. No real usage-weighted lifetime cost is claimed.',
        ] };
}

export function writeReport(directory: string, config: StudyConfig, corpus: Corpus): void {
    const frozenFile = path.join(directory, 'runtime.freeze.json');
    if (!fs.existsSync(frozenFile)) throw new Error('No measured runtime yet. Run the study first.');
    const frozen = readJson<FrozenRun>(frozenFile);
    const results = jsonFiles(path.join(directory, 'results')).map(file => readJson<JobResult>(file));
    const attempts = jsonFiles(path.join(directory, 'attempts')).map(file => readJson<Attempt>(file));
    if ([...results, ...attempts].some(r => r.fingerprint !== frozen.fingerprint)) throw new Error('Mixed result fingerprints; report refused');
    const summary = summarize(config, corpus, results, attempts);
    const scheduled = productJobs(config, corpus, 'development');
    const done = scheduled.filter(j => results.some(r => r.job.id === j.id && r.state === 'COMPLETED')).length;
    const report = { ...summary, runtime: frozen, developmentProgress: { completed: done, expected: scheduled.length }, createdAt: new Date().toISOString() };
    atomicJson(path.join(directory, 'summary.json'), report);
    const perGame = results.map(r => ({ split: corpus.games[r.job.gameIndex]?.split, account: corpus.games[r.job.gameIndex]?.account,
        rating: corpus.games[r.job.gameIndex]?.rating, gameId: corpus.games[r.job.gameIndex]?.game.id,
        kind: r.job.kind, profile: r.job.profileId, state: r.state,
        admitted: r.strategy?.decisions.filter(d => d.admitted).length ?? '',
        nodes: r.meter.requestedNodes, reportedNodes: r.meter.reportedNodes, cpuSeconds: r.meter.cpuSeconds,
        wallMs: r.meter.wallMs, error: r.error ?? '' }));
    if (perGame.length) {
        const keys = Object.keys(perGame[0]) as Array<keyof typeof perGame[number]>;
        fs.writeFileSync(path.join(directory, 'per-game.csv'), [keys.join(','), ...perGame.map(r => keys.map(k => csv(r[k])).join(','))].join('\n') + '\n');
    }
    const rows = summary.rows.map(r => `| ${r.split} | ${r.profile} | ${r.completedGames} | ${r.admitted} | ${(r.productAttemptNodes / 1e6).toFixed(1)} | ${r.productAttemptCpuSeconds.toFixed(1)} | ${r.sampledGoodOriginal}/${r.sampledAdmitted - r.sampledUnknown} | ${r.sampledUnknown}/${r.sampledAdmitted} |`);
    const text = `# Výsledky experimentu extractoru\n\nDevelopment: ${done}/${scheduled.length} hotových produktových a referenčních úloh. ${done === scheduled.length ? 'Tato fáze je kompletní.' : '**Výsledky jsou částečné.**'}\n\n` +
        `| Split | Profil | Hotové partie | Přijaté odhady | Miliony uzlů včetně retries | CPU s včetně retries | Původní tah auditně GOOD / rozhodnutý vzorek přijetí | Audit UNKNOWN / vzorek přijetí |\n|---|---|---:|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\n` +
        `Tabulka auditních počtů obsahuje raw vzorek; vážené míry, rozpětí při UNKNOWN, grading a účty jsou v summary.json. Nejde o hotové rozhodnutí o produkčním nastavení.\n\n` +
        `Celý experiment včetně reference a neúspěšných pokusů: ${(summary.totalExperiment.nodes / 1e9).toFixed(3)} miliardy rezervovaných uzlů a ${(summary.totalExperiment.cpu / 3600).toFixed(2)} CPU hodin.\n\n` +
        `Vybrané cílené audity: ${summary.selectedAudit.completedJobs}/${summary.selectedAudit.resultFiles} dokončených úloh, ${summary.selectedAudit.completedPositions} pozic. Tyto pozice nevstupují do populačních odhadů ani běžného výběru odpovědí.\n\n` +
        `## Jak předat výsledky\n\nPředej celý tento adresář; summary.json, per-game.csv a tento soubor stačí pro první přehled. Pro rozbor příčin jsou potřeba také results/, attempts/, evidence/, corpus.json a zmrazené konfigurace.\n\n` +
        `## Omezení\n\n${summary.limitations.map(s => `- ${s}`).join('\n')}\n`;
    fs.writeFileSync(path.join(directory, 'VYSLEDKY.md'), text);
    console.log(`Report: ${path.join(directory, 'VYSLEDKY.md')}`);
}
