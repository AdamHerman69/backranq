import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { canonicalJson, configHash, loadConfig } from './config';
import { prepareCorpus } from './corpus';
import { atomicJson, hash, jsonFiles, readJson, withLock } from './io';
import { isPopulationReference, makeJob, productJobs, spent } from './jobs';
import { emptyMeter } from './meter';
import { runWorker } from './worker';
import { selectedAuditJobs } from './selectedAudit';
import { writeReport } from './report';
import type { Corpus, StudyConfig } from './types';
import type { Attempt, FrozenRun, Job, JobResult, WorkerInput } from './records';

const HELP = `Extractor study (no work runs without an explicit command)
  pnpm extractor-study plan     [--config file]
  pnpm extractor-study prepare  [--config file]     public blitz data only
  pnpm extractor-study run      [--config file]     development profiles + audit
  pnpm extractor-study answers  [--profiles B0,B2,E0,E3] [--config file]
  pnpm extractor-study audit-selected --audit-plan file --config file
  pnpm extractor-study report   [--config file]
  pnpm extractor-study status   [--config file]
  pnpm extractor-study all      [--config file]     prepare, run, answers, report
  pnpm extractor-study freeze   --winner E3 [--config file]
  pnpm extractor-study run      --split holdout [--config file]

Optional: --max-jobs N stops after N new jobs; rerun to resume.
Failed/censored jobs require --retry-failed; all prior attempt costs are retained.
Default config: experiments/extractor-economics/blitz.json
No production DB, deployment, account credentials or hosted services are used.
`;

export function parseArgs(argv: string[]) {
    const command = argv[0] ?? 'help';
    if (!['help', 'plan', 'prepare', 'run', 'answers', 'report', 'status', 'all', 'freeze', 'audit-selected'].includes(command)) throw new Error(`Unknown command ${command}`);
    const options: Record<string, string | boolean> = {};
    for (let i = 1; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--retry-failed') { options[flag] = true; continue; }
        if (!['--config', '--split', '--profiles', '--winner', '--max-jobs', '--audit-plan'].includes(flag)) throw new Error(`Unknown option ${flag}`);
        if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
        if (flag in options) throw new Error(`Duplicate option ${flag}`);
        options[flag] = argv[++i];
    }
    const split = options['--split'] ?? 'development';
    if (!['development', 'holdout'].includes(String(split))) throw new Error('split must be development or holdout');
    const maxJobs = options['--max-jobs'] == null ? Infinity : Number(options['--max-jobs']);
    if (maxJobs !== Infinity && (!Number.isSafeInteger(maxJobs) || maxJobs < 1)) throw new Error('max-jobs must be a positive integer');
    if (command === 'all' && maxJobs !== Infinity) throw new Error('Use --max-jobs with run or answers separately; all spans multiple phases.');
    return { command, configPath: String(options['--config'] ?? 'experiments/extractor-economics/blitz.json'),
        split: split as 'development' | 'holdout', maxJobs, retryFailed: options['--retry-failed'] === true,
        auditPlan: options['--audit-plan'] ? String(options['--audit-plan']) : undefined,
        winner: options['--winner'] ? String(options['--winner']) : undefined,
        profiles: String(options['--profiles'] ?? 'B0,B2,E0,E3').split(',') };
}

function loadCorpus(config: StudyConfig, directory: string): Corpus {
    const corpus = readJson<Corpus>(path.join(directory, 'corpus.json'));
    if (!corpus.complete || corpus.configHash !== configHash(config)) throw new Error('Corpus incomplete or configuration changed; run prepare in a new output directory.');
    if (hash(canonicalJson(corpus)) !== fs.readFileSync(path.join(directory, 'corpus.sha256'), 'utf8').trim()) throw new Error('Frozen corpus checksum changed');
    return corpus;
}

function freezeRuntime(config: StudyConfig, corpus: Corpus, directory: string): FrozenRun {
    const bundleHash = hash(fs.readFileSync(fileURLToPath(import.meta.url)));
    const engineFiles = Object.fromEntries(['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm']
        .map(name => [name, hash(fs.readFileSync(path.resolve('node_modules/stockfish/bin', name)))]));
    for (const file of ['src/lib/analysis/serverStockfishProcess.mjs', 'scripts/extractor-study/cpu-hook.mjs',
        'package.json', 'pnpm-lock.yaml', 'node_modules/chess.js/package.json',
        'node_modules/chess.js/dist/cjs/chess.js', 'node_modules/chess.js/dist/esm/chess.js']) {
        engineFiles[file] = hash(fs.readFileSync(file));
    }
    const identity = { configHash: configHash(config), corpusHash: hash(canonicalJson(corpus)), bundleHash,
        engineFiles, nodeVersion: process.version, platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0]?.model ?? 'unknown' };
    const fingerprint = hash(canonicalJson(identity));
    const file = path.join(directory, 'runtime.freeze.json');
    if (fs.existsSync(file)) {
        const prior = readJson<FrozenRun>(file);
        if (prior.fingerprint !== fingerprint) throw new Error('Code, engine, corpus, config or runtime changed. Preserve results and use a new outputDirectory.');
        return prior;
    }
    const frozen = { ...identity, fingerprint, createdAt: new Date().toISOString() };
    atomicJson(file, frozen); return frozen;
}

async function executeJobs(config: StudyConfig, corpus: Corpus, directory: string, frozen: FrozenRun, jobs: Job[], args: ReturnType<typeof parseArgs>) {
    reconcileAttempts(directory, frozen.fingerprint);
    let completedNow = 0;
    for (const [index, job] of jobs.entries()) {
        const resultPath = path.join(directory, 'results', `${job.id}.json`);
        if (fs.existsSync(resultPath)) {
            const result = readJson<JobResult>(resultPath);
            if (result.fingerprint !== frozen.fingerprint) throw new Error('Result fingerprint mismatch');
            if (result.state === 'COMPLETED') continue;
            if (!args.retryFailed) throw new Error(`Job ${job.id} is ${result.state}: ${result.error}. Inspect it, then use --retry-failed if appropriate.`);
        }
        if (completedNow >= args.maxJobs) { console.log('Requested job limit reached. Rerun the same command to continue.'); return false; }
        const journals = jsonFiles(path.join(directory, 'attempts')).map(file => readJson<Attempt>(file));
        if (journals.some(a => a.fingerprint !== frozen.fingerprint)) throw new Error('Attempt fingerprint mismatch');
        const usage = spent(journals);
        const remainingNodes = config.limits.globalNodes - usage.nodes;
        const remainingCpu = config.limits.globalCpuSeconds - usage.cpu;
        if (remainingNodes <= 0 || remainingCpu <= 0) throw new Error('Global study budget exhausted; no further jobs dispatched.');
        // Do not silently truncate a scheduled comparison to spend the last nodes.
        const required = job.kind === 'ANSWER' ? Math.min(2000000, config.limits.perJobNodes) : config.limits.perJobNodes;
        if (remainingNodes < required) throw new Error('Remaining node budget cannot reserve the next whole job. Existing results remain valid.');
        const attemptNumber = journals.filter(a => a.job.id === job.id).length + 1;
        const journalPath = path.join(directory, 'attempts', `${job.id}-${attemptNumber}.json`);
        const input: WorkerInput = { directory, journalPath, resultPath, fingerprint: frozen.fingerprint, config, corpus, job,
            profile: config.profiles.find(p => p.id === job.profileId), attempt: attemptNumber,
            nodeAllowance: required, cpuAllowance: Math.min(remainingCpu, config.limits.perJobSeconds) };
        const inputPath = path.join(directory, 'inputs', `${job.id}-${attemptNumber}.json`);
        atomicJson(inputPath, input);
        const initial: Attempt = { fingerprint: frozen.fingerprint, job, attempt: attemptNumber, state: 'RUNNING',
            startedAt: new Date().toISOString(), meter: emptyMeter(), nodeAllowance: required, cpuAllowance: input.cpuAllowance };
        atomicJson(journalPath, initial);
        console.log(`[${index + 1}/${jobs.length}] ${job.kind} ${job.profileId} ${corpus.games[job.gameIndex].account} game ${job.gameIndex + 1}`);
        const logFile = path.join(directory, 'logs', `${job.id}-${attemptNumber}.log`);
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const log = fs.openSync(logFile, 'a');
        let interrupted = false;
        let timedOut = false;
        const exitCode = await new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_worker', inputPath], { stdio: ['ignore', log, log, 'ipc'], cwd: process.cwd() });
            if (child.pid) {
                const owner = readJson<Attempt>(journalPath);
                owner.workerPid = child.pid; owner.host = os.hostname(); atomicJson(journalPath, owner);
            }
            const stop = () => { interrupted = true; child.kill('SIGTERM'); };
            process.once('SIGINT', stop); process.once('SIGTERM', stop);
            let forceTimer: ReturnType<typeof setTimeout> | undefined;
            const timer = setTimeout(() => {
                timedOut = true; child.kill('SIGTERM');
                forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
            }, Math.min(config.limits.perJobSeconds, input.cpuAllowance) * 1000);
            const interruptForce = setInterval(() => {
                if (interrupted && !forceTimer) forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
            }, 250);
            const cleanup = () => {
                clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); clearInterval(interruptForce);
                process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); fs.closeSync(log);
            };
            child.once('error', error => { cleanup(); reject(error); });
            child.once('exit', code => { cleanup(); resolve(code); });
        });
        const journal = readJson<Attempt>(journalPath);
        if (journal.state === 'RUNNING' || timedOut || interrupted) {
            journal.state = timedOut ? 'CENSORED' : 'FAILED';
            journal.error = timedOut ? 'WATCHDOG' : interrupted ? 'INTERRUPTED' : `WORKER_EXIT_${exitCode}`;
            // Last in-flight CPU update may be missing after a kill. Charge the allowance,
            // not zero; cost report explicitly distinguishes failed reservations.
            journal.meter.cpuSeconds = Math.max(journal.meter.cpuSeconds, input.cpuAllowance);
            atomicJson(journalPath, journal);
            atomicJson(resultPath, { fingerprint: frozen.fingerprint, job, state: journal.state, meter: journal.meter, error: journal.error } satisfies JobResult);
        }
        if (exitCode !== 0 || journal.state !== 'COMPLETED') throw new Error(`Job stopped: ${journal.error ?? exitCode}. See ${logFile}. Resume with --retry-failed after inspection.`);
        completedNow++;
        console.log(`  ${(journal.meter.requestedNodes / 1e6).toFixed(2)}M nodes, ${journal.meter.cpuSeconds.toFixed(1)} CPU s, ${(journal.meter.wallMs / 1000).toFixed(1)} elapsed s`);
    }
    return true;
}

export function reconcileAttempts(directory: string, fingerprint: string): void {
    for (const file of jsonFiles(path.join(directory, 'attempts'))) {
        const attempt = readJson<Attempt>(file);
        if (attempt.fingerprint !== fingerprint) throw new Error('Attempt fingerprint mismatch');
        if (attempt.state !== 'RUNNING') continue;
        if (attempt.workerPid) {
            if (attempt.host !== os.hostname()) throw new Error('A RUNNING attempt belongs to another host. Verify that worker has stopped before resuming.');
            let alive = true;
            try { process.kill(attempt.workerPid, 0); } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
            }
            if (alive) throw new Error(`Previous worker PID ${attempt.workerPid} is still alive. Wait for owned cleanup; do not launch duplicate work.`);
        }
        attempt.state = 'FAILED'; attempt.error = 'INTERRUPTED_WORKER_RECONCILED';
        attempt.meter.cpuSeconds = Math.max(attempt.meter.cpuSeconds, attempt.cpuAllowance);
        atomicJson(file, attempt);
        atomicJson(path.join(directory, 'results', `${attempt.job.id}.json`), {
            fingerprint, job: attempt.job, state: 'FAILED', meter: attempt.meter, error: attempt.error,
        } satisfies JobResult);
    }
}

export function answerJobs(config: StudyConfig, corpus: Corpus, directory: string, split: 'development' | 'holdout', profiles: string[]): Job[] {
    if (!profiles.length || profiles.length > 4 || new Set(profiles).size !== profiles.length || profiles.some(id => !config.profiles.some(p => p.id === id))) throw new Error('answers requires 1–4 distinct configured profile IDs');
    const references = jsonFiles(path.join(directory, 'results')).map(p => readJson<JobResult>(p))
        .filter(r => r.state === 'COMPLETED' && isPopulationReference(r.job) && corpus.games[r.job.gameIndex].split === split);
    const samples = references.flatMap(r => r.reference!.samples.filter(s => s.stratum === 'ADMITTED').map(sample => ({ gameIndex: r.job.gameIndex, sample })))
        .sort((a, b) => hash(`${config.seed}:answers:${a.gameIndex}:${a.sample.ply}`).localeCompare(hash(`${config.seed}:answers:${b.gameIndex}:${b.sample.ply}`)))
        .slice(0, split === 'development' ? 64 : 32);
    if (!samples.length) throw new Error('No audited admitted positions; run profiles and reference first.');
    const jobs: Job[] = [];
    for (const { gameIndex, sample } of samples) {
        const board = new Chess(); board.loadPgn(corpus.games[gameIndex].game.pgn);
        const source = board.history({ verbose: true })[sample.ply];
        const legal = new Chess(source.before).moves({ verbose: true }).map(m => m.lan)
            .sort((a, b) => hash(`${config.seed}:${gameIndex}:${sample.ply}:${a}`).localeCompare(hash(`${config.seed}:${gameIndex}:${sample.ply}:${b}`)));
        const candidates = [...new Set([sample.decision.originalMoveUci, sample.decision.preferredMoveUci,
            sample.alternatives.find(a => a.estimate === 'GOOD' && a.moveUci !== sample.decision.preferredMoveUci)?.moveUci,
            sample.alternatives.find(a => a.estimate === 'BELOW_STANDARD')?.moveUci,
            sample.alternatives.find(a => a.estimate === 'UNKNOWN')?.moveUci, legal[0],
            ...sample.alternatives.map(a => a.moveUci)].filter((m): m is string => !!m && legal.includes(m)))].slice(0, 6);
        for (const profileId of profiles) {
            const productFile = path.join(directory, 'results', makeJob('PRODUCT', gameIndex, profileId).id + '.json');
            if (!fs.existsSync(productFile) || readJson<JobResult>(productFile).state !== 'COMPLETED') throw new Error(`Missing completed product ${profileId} for answer workload`);
            for (const move of candidates) jobs.push(makeJob('ANSWER', gameIndex, profileId, sample.ply, move));
        }
    }
    return jobs;
}

export async function main(argv: string[]): Promise<void> {
    if (argv[0] === '_worker') { await runWorker(readJson<WorkerInput>(argv[1])); return; }
    const args = parseArgs(argv);
    if (args.command === 'help') { console.log(HELP); return; }
    const config = loadConfig(args.configPath);
    validateCommandConfig(args, config);
    const directory = path.resolve(config.outputDirectory);
    if (args.command === 'plan') {
        console.log(JSON.stringify({ config, expectedGames: config.discovery.accountsPerBucket * config.discovery.ratingEdges.length * config.discovery.gamesPerAccount,
            developmentGames: config.discovery.developmentAccountsPerBucket * config.discovery.ratingEdges.length * config.discovery.gamesPerAccount,
            note: 'Planning only. No network, engine, or corpus writes. Admission records are experimental, not production-ready puzzles.' }, null, 2)); return;
    }
    const unlock = withLock(directory);
    try {
        if (args.command === 'prepare' || args.command === 'all') {
            await prepareCorpus(config, directory);
            console.log(`Frozen corpus: ${path.join(directory, 'corpus.json')}`);
            if (args.command === 'prepare') return;
        }
        const corpus = loadCorpus(config, directory);
        if (args.command === 'status') {
            const attempts = jsonFiles(path.join(directory, 'attempts')).map(file => readJson<Attempt>(file));
            console.log(JSON.stringify({ games: corpus.games.length, results: jsonFiles(path.join(directory, 'results')).length, attempts: attempts.length, spent: spent(attempts) }, null, 2)); return;
        }
        if (args.command === 'report') { writeReport(directory, config, corpus); return; }
        const frozen = freezeRuntime(config, corpus, directory);
        if (args.command === 'audit-selected') {
            const jobs = selectedAuditJobs(readJson<unknown>(args.auditPlan!), corpus);
            const planned = { fingerprint: frozen.fingerprint, jobs };
            const planFile = path.join(directory, 'selected-audit-jobs.json');
            if (fs.existsSync(planFile) && canonicalJson(readJson(planFile)) !== canonicalJson(planned)) throw new Error('Selected audit plan changed; use a new output directory.');
            atomicJson(planFile, planned);
            const complete = await executeJobs(config, corpus, directory, frozen, jobs, args);
            console.log(complete ? 'Selected reference audit complete (explicit subset, not a population estimate).' : 'Selected audit paused at job limit.');
            return;
        }
        const selectionPath = path.join(directory, 'winner.freeze.json');
        let winner: string | undefined;
        if (fs.existsSync(selectionPath)) {
            const selected = readJson<{ fingerprint: string; winner: string }>(selectionPath);
            if (selected.fingerprint !== frozen.fingerprint) throw new Error('Winner fingerprint mismatch');
            winner = selected.winner;
        }
        if (args.command === 'freeze') {
            if (!args.winner || !config.profiles.some(p => p.id === args.winner)) throw new Error('Specify a configured --winner');
            if (winner && winner !== args.winner) throw new Error('Winner already frozen. Never retune against the same holdout.');
            const expected = productJobs(config, corpus, 'development');
            if (expected.some(j => !fs.existsSync(path.join(directory, 'results', j.id + '.json')) || readJson<JobResult>(path.join(directory, 'results', j.id + '.json')).state !== 'COMPLETED')) throw new Error('Complete development profiles and reference before freezing a winner');
            if (config.reference.enabled) {
                const gradingJobs = answerJobs(config, corpus, directory, 'development', [...new Set(['B0', 'B2', args.winner])]);
                if (gradingJobs.some(j => !fs.existsSync(path.join(directory, 'results', j.id + '.json')) || readJson<JobResult>(path.join(directory, 'results', j.id + '.json')).state !== 'COMPLETED')) throw new Error('Complete answers --profiles B0,B2,' + args.winner + ' before freezing. Freeze records your selection; it does not certify quality.');
            }
            atomicJson(selectionPath, { fingerprint: frozen.fingerprint, winner: args.winner, frozenAt: new Date().toISOString() });
            console.log(`Winner frozen: ${args.winner}. Holdout remains unrun.`); return;
        }
        if (args.split === 'holdout' && !winner) throw new Error('Use freeze --winner PROFILE before holdout.');
        if (args.command === 'run' || args.command === 'all') {
            const jobs = productJobs(config, corpus, args.split, winner);
            atomicJson(path.join(directory, `jobs-${args.split}.json`), { fingerprint: frozen.fingerprint, jobs });
            const complete = await executeJobs(config, corpus, directory, frozen, jobs, args);
            writeReport(directory, config, corpus);
            if (!complete || args.command === 'run') return;
        }
        if (args.command === 'answers' || args.command === 'all') {
            if (args.split === 'holdout' && args.profiles.some(id => !['B0', 'B2', winner].includes(id))) throw new Error('Holdout answers are limited to B0,B2 and the frozen winner. Supply --profiles.');
            const jobs = answerJobs(config, corpus, directory, args.split, args.profiles);
            atomicJson(path.join(directory, `answer-jobs-${args.split}.json`), { fingerprint: frozen.fingerprint, jobs });
            await executeJobs(config, corpus, directory, frozen, jobs, args);
            writeReport(directory, config, corpus);
        }
    } finally { unlock(); }
}

export function validateCommandConfig(args: ReturnType<typeof parseArgs>, config: StudyConfig): void {
    if (args.command === 'audit-selected' && (!args.auditPlan || args.split !== 'development' || !config.reference.enabled)) throw new Error('audit-selected requires --audit-plan, reference.enabled, and development split.');
    if (args.auditPlan && args.command !== 'audit-selected') throw new Error('--audit-plan is only valid with audit-selected');
    if (args.command === 'all' || args.command === 'answers') {
        if (!config.reference.enabled) throw new Error('all/answers require reference.enabled=true. Use prepare and run for an unaudited extraction-only study.');
        if (!args.profiles.length || args.profiles.length > 4 || new Set(args.profiles).size !== args.profiles.length
            || args.profiles.some(id => !config.profiles.some(p => p.id === id))) throw new Error('Supply --profiles with 1–4 distinct configured IDs for the answer phase.');
    }
    if (args.command === 'all' && args.split === 'holdout') throw new Error('For holdout use run, then answers --split holdout --profiles B0,B2,WINNER separately.');
}
