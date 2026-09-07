import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import { Chess } from 'chess.js';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { validateTrainingMomentCandidates } from '@/lib/training/candidateValidation';
import { canonicalJson, validatePracticeMomentRevision, type PracticeMomentRevision } from '@/lib/training/practiceContract';
import type { NormalizedGame } from '@/lib/types/game';

/** Real engine corpus capture. Outputs remain local audit artifacts, never publications. */
export async function main(argv: string[]) {
    const directory = path.resolve(argv[0] ?? 'artifacts/practice-v4-audit');
    const maximumGames = Number(argv[1] ?? 16);
    const targetMoments = Number(argv[2] ?? 60);
    const perspective = argv[3] ?? 'imported-player';
    if (!['imported-player', 'both-players'].includes(perspective)) throw new Error('Unknown corpus perspective');
    if (!Number.isInteger(maximumGames) || maximumGames < 1 || !Number.isInteger(targetMoments) || targetMoments < 1) throw new Error('Positive maximum games and target moments required');
    fs.mkdirSync(directory, { recursive: true });
    const input = fs.readFileSync('tests/fixtures/training-v2/real-games.corpus.v1.json', 'utf8');
    const corpus = JSON.parse(input) as { games: NormalizedGame[] };
    // Both players are real recorded players; only the audit's selected account
    // changes. PGN, game ID, move order and extraction budgets remain unchanged.
    const games = [...corpus.games];
    if (perspective === 'both-players') for (const game of corpus.games) {
        const originalSide = game.provenance?.userSide;
        if (originalSide !== 'white' && originalSide !== 'black') throw new Error('Both-player audit requires an explicit imported side');
        const userSide = originalSide === 'white' ? 'black' : 'white';
        games.push({ ...game, provenance: { username: game[userSide].name, userSide, timeControl: game.provenance?.timeControl } });
    }
    // Focused regressions still replay whole, unchanged games. Explicit corpus
    // indices preserve both the source selection and its player perspective.
    const selectionArg = argv[4];
    if (selectionArg && !/^--game-indices=\d+(,\d+)*$/.test(selectionArg)) throw new Error('Expected --game-indices=0,1,...');
    const selectedIndices = selectionArg ? selectionArg.slice('--game-indices='.length).split(',').map(Number) : null;
    if (selectedIndices && (new Set(selectedIndices).size !== selectedIndices.length
        || selectedIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= games.length))) throw new Error('Unique in-range corpus game indices required');
    // The bundled program contains exactly the transitive runtime used by this capture.
    const fingerprint = createHash('sha256').update(fs.readFileSync(new URL(import.meta.url)))
        .update(input).update(perspective).update(canonicalJson(selectedIndices)).update('scan100k-confirm200k-max800k').digest('hex');
    const summary: Record<string, unknown> = { corpusSha256: createHash('sha256').update(input).digest('hex'),
        hardware: { cpu: cpus()[0]?.model, cores: cpus().length, platform: platform(), release: release() },
        fingerprint, perspective, selectedIndices, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), startedAt: new Date().toISOString(), profile: { nodesPerPosition: 100_000, confirmNodes: 200_000, maxConfirmationNodes: 800_000 }, games: [] };
    const rows = summary.games as unknown[];
    const contexts = new Set<string>();
    const emitted = new Map<string, PracticeMomentRevision>();
    const writeInput = () => {
        if (!emitted.size) return;
        const file = path.join(directory, 'input-manifests.json'); const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ version: 1, extractorFingerprint: fingerprint, manifests: [...emitted.values()] }, null, 2));
        fs.renameSync(temp, file);
    };
    const register = (moments: Awaited<ReturnType<typeof extractTrainingMomentsFromGames>>['moments'], game: NormalizedGame) => {
        const board = new Chess(); board.loadPgn(game.pgn); const sourceMoves = board.history({ verbose: true });
        const validation = [];
        for (const moment of moments) {
            const manifest = moment.solution.manifest;
            const checked = { ply: moment.decisionPly, canonical: validatePracticeMomentRevision(manifest).success, candidate: validateTrainingMomentCandidates([moment]).ok };
            validation.push(checked);
            if (!checked.canonical || !checked.candidate) throw new Error('Invalid extractor manifest');
            const source = manifest.source; const played = sourceMoves[source.decisionPly];
            if (!played || source.sourcePgnHash !== hashSourcePgn(game.pgn) || source.fen !== played.before || source.originalMoveUci !== played.lan
                || canonicalJson(source.positionHistory) !== canonicalJson(sourceMoves.slice(Math.max(0, source.decisionPly - source.positionHistory.length), source.decisionPly).map(move => move.before))) throw new Error('Extractor manifest differs from corpus source replay');
            // Reanalysis negative revisions remain audit diagnostics, never the
            // sixty positive practice-moment target or comparator feed inputs.
            if (manifest.decision.status !== 'CONFIRMED_MISTAKE' || manifest.decision.selection !== 'INCLUDED') continue;
            if (!emitted.has(source.contextId)) emitted.set(source.contextId, manifest);
            contexts.add(source.contextId);
        }
        writeInput();
        return validation;
    };
    const scheduledIndices = (selectedIndices ?? games.map((_, index) => index)).slice(0, maximumGames);
    for (const index of scheduledIndices) {
        if (contexts.size >= targetMoments) break;
        const game = games[index];
        const target = path.join(directory, `game-${index}.json`);
        if (fs.existsSync(target)) {
            const row = JSON.parse(fs.readFileSync(target,'utf8'));
            if (row.fingerprint !== fingerprint) throw new Error('Audit resume fingerprint mismatch; use a fresh output directory');
            register(row.output.moments, game);
            rows.push(row.summary); continue;
        }
        const engine = new ServerStockfishClient(); const started = performance.now();
        try {
            const output = await extractTrainingMomentsFromGames({ games: [game], selectedGameIds: new Set([game.id]), engine,
                options: { nodesPerPosition: 100_000, confirmNodes: 200_000, maxConfirmationNodes: 800_000, returnAnalysis: true } });
            const extractionMs = performance.now() - started;
            const validationStarted = performance.now();
            const validation = register(output.moments, game);
            const validationMs = performance.now() - validationStarted;
            const row = { corpusIndex: index, uniqueContexts: contexts.size, engineWork: output.engineWork, gameId: game.id, selectedSide: game.provenance?.userSide,
                extractionMs, validationMs, captureTotalMs: performance.now() - started, moments: output.moments.length,
                trainableMoments: output.moments.filter(moment => moment.solution.manifest.decision.status === 'CONFIRMED_MISTAKE' && moment.solution.manifest.decision.selection === 'INCLUDED').length,
                complete: output.manifests[0]?.complete, validation };
            fs.writeFileSync(target, JSON.stringify({ fingerprint, summary: row, output: { ...output, analysis: Object.fromEntries(output.analysis ?? []) } }, null, 2));
            rows.push(row); console.log(JSON.stringify(row));
            if (validation.some(value => !value.canonical || !value.candidate)) throw new Error('Real extractor produced an invalid manifest');
        } finally { engine.terminate(); }
        fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    }
    // Source positions are included to make exact source/replay and sample selection auditable.
    summary.sourcePositionCount = corpus.games.reduce((sum, game) => { const board = new Chess(); board.loadPgn(game.pgn); return sum + board.history().length; }, 0);
    summary.uniqueContexts = contexts.size;
    summary.targetReached = contexts.size >= targetMoments;
    summary.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
}
