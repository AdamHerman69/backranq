import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';

import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import type { TrainingExtractionReceipt } from '@/lib/analysis/extractionReceipt';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import type {
    AnalysisLimit,
    EvalResult,
    MultiPvResult,
    StockfishEngine,
} from '@/lib/analysis/stockfishClient';
import { fetchChessComGames } from '@/lib/providers/chesscom';
import { fetchLichessGames } from '@/lib/providers/lichess';
import type { NormalizedGame } from '@/lib/types/game';

const repositoryRoot = process.cwd();
const corpusPath = path.join(
    repositoryRoot,
    'tests/fixtures/training-v2/real-games.corpus.v1.json'
);
const reportDirectory = path.join(
    repositoryRoot,
    'artifacts/extraction-quality-lab'
);
const allowedTimeClasses = new Set(['blitz', 'rapid']);
const targetPerProviderAndTimeClass = 4;
const authorizedSources = [
    { provider: 'chesscom', username: 'adam1a4' },
    { provider: 'lichess', username: 'aldicigg' },
] as const;

type CorpusSource = {
    provider: 'chesscom' | 'lichess';
    username: string;
};

type QualityCorpus = {
    version: 1;
    generatedAt: string;
    filters: {
        variants: ['standard'];
        timeClasses: ['blitz', 'rapid'];
        maxPlies: number;
    };
    sources: CorpusSource[];
    games: NormalizedGame[];
};

type EngineCost = {
    searches: number;
    evalSearches: number;
    multiPvSearches: number;
    requestedNodes: number;
    largestMultiPv: number;
};

type Profile = {
    name: 'product' | 'confirmation-candidate' | 'reference';
    nodesPerPosition: number;
    confirmNodes: number;
    maxConfirmationNodes: number;
    verificationNodesPerPosition: number;
};

type MomentSnapshot = {
    key: string;
    decisionPly: number;
    trainable: boolean;
    sourceKinds: string[];
    verificationStatus: string;
    solutionShape: string;
    bestMoveUci: string;
    acceptedMovesUci: string[];
};

type GameRun = {
    gameId: string;
    provider: string;
    timeClass: string;
    playedAt: string;
    complete: boolean;
    manifestErrors: string[];
    wallTimeMs: number;
    cost: EngineCost;
    moments: MomentSnapshot[];
    extractionReceipt: TrainingExtractionReceipt | null;
    receiptReasons: Record<string, number>;
};

type ProfileRun = {
    profile: Profile;
    games: GameRun[];
    totals: {
        games: number;
        completedGames: number;
        candidates: number;
        moments: number;
        wallTimeMs: number;
        cost: EngineCost;
        verificationStatuses: Record<string, number>;
        receiptReasons: Record<string, number>;
    };
};

function parseArgs(args: string[]) {
    const command = args[0] ?? 'full';
    const limitArg = args.find((arg) => arg.startsWith('--limit='));
    const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : null;
    if (!['refresh', 'smoke', 'full', 'confirmation'].includes(command)) {
        throw new Error(`Unknown quality-lab command: ${command}`);
    }
    if (
        limit != null &&
        (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    ) {
        throw new Error('--limit must be an integer from 1 to 100');
    }
    return {
        command: command as
            | 'refresh'
            | 'smoke'
            | 'full'
            | 'confirmation',
        limit,
    };
}

function pgnPlies(pgn: string): number {
    const chess = new Chess();
    chess.loadPgn(pgn, { strict: false });
    return chess.history().length;
}

function isStandardPgn(pgn: string): boolean {
    const variant = /^\[Variant\s+"([^"]+)"\]\s*$/im.exec(pgn)?.[1];
    return variant == null || variant.toLowerCase() === 'standard';
}

function validateCorpus(corpus: QualityCorpus): QualityCorpus {
    if (
        corpus.version !== 1 ||
        corpus.filters.timeClasses.join(',') !== 'blitz,rapid' ||
        corpus.filters.variants.join(',') !== 'standard' ||
        corpus.filters.maxPlies !== 120 ||
        JSON.stringify(corpus.sources) !== JSON.stringify(authorizedSources) ||
        corpus.games.length === 0
    ) {
        throw new Error('Invalid extraction quality corpus header');
    }
    const sources = new Map(
        corpus.sources.map((source) => [source.provider, source.username])
    );
    const ids = new Set<string>();
    for (const game of corpus.games) {
        const expectedUsername = sources.get(game.provider);
        const expected = expectedUsername?.toLocaleLowerCase('en-US');
        const white = game.white.name.toLocaleLowerCase('en-US');
        const black = game.black.name.toLocaleLowerCase('en-US');
        const plies = pgnPlies(game.pgn);
        if (
            !expected ||
            !allowedTimeClasses.has(game.timeClass) ||
            (white === expected) === (black === expected) ||
            !isStandardPgn(game.pgn) ||
            plies < 1 ||
            plies > corpus.filters.maxPlies ||
            ids.has(game.id)
        ) {
            throw new Error(
                `Invalid corpus game ${game.id}: provider, player, time class, PGN, or identity mismatch`
            );
        }
        ids.add(game.id);
    }
    for (const provider of ['chesscom', 'lichess'] as const) {
        for (const timeClass of ['blitz', 'rapid'] as const) {
            const count = corpus.games.filter(
                (game) =>
                    game.provider === provider &&
                    game.timeClass === timeClass
            ).length;
            if (count !== targetPerProviderAndTimeClass) {
                throw new Error(
                    `Invalid corpus balance for ${provider}:${timeClass}: expected ${targetPerProviderAndTimeClass}, received ${count}`
                );
            }
        }
    }
    return corpus;
}

function balancedGames(games: NormalizedGame[], provider: string) {
    const selected: NormalizedGame[] = [];
    for (const timeClass of ['blitz', 'rapid'] as const) {
        selected.push(
            ...games
                .filter(
                    (game) =>
                        game.provider === provider &&
                        game.timeClass === timeClass &&
                        isStandardPgn(game.pgn) &&
                        pgnPlies(game.pgn) <= 120
                )
                .sort((left, right) =>
                    right.playedAt.localeCompare(left.playedAt)
                )
                .slice(0, targetPerProviderAndTimeClass)
        );
    }
    return selected;
}

function sampleCorpusGames(
    games: NormalizedGame[],
    limit: number
): NormalizedGame[] {
    const bucketOrder = [
        'chesscom:blitz',
        'lichess:rapid',
        'chesscom:rapid',
        'lichess:blitz',
    ] as const;
    const buckets = new Map(
        bucketOrder.map((key) => [
            key,
            games.filter(
                (game) => `${game.provider}:${game.timeClass}` === key
            ),
        ])
    );
    const selected: NormalizedGame[] = [];
    for (
        let index = 0;
        selected.length < Math.min(limit, games.length);
        index += 1
    ) {
        let added = false;
        for (const key of bucketOrder) {
            const game = buckets.get(key)?.[index];
            if (!game) continue;
            selected.push(game);
            added = true;
            if (selected.length === Math.min(limit, games.length)) break;
        }
        if (!added) break;
    }
    return selected;
}

async function refreshCorpus() {
    const [chesscom, lichess] = await Promise.all([
        fetchChessComGames({
            username: 'adam1a4',
            filters: {
                max: 500,
                timeClasses: ['blitz', 'rapid'],
            },
        }),
        fetchLichessGames({
            username: 'aldicigg',
            filters: {
                max: 500,
                timeClasses: ['blitz', 'rapid'],
            },
        }),
    ]);
    const games = [
        ...balancedGames(chesscom.games, 'chesscom'),
        ...balancedGames(lichess.games, 'lichess'),
    ].sort((left, right) =>
        `${left.provider}:${left.timeClass}:${left.id}`.localeCompare(
            `${right.provider}:${right.timeClass}:${right.id}`
        )
    );
    const corpus = validateCorpus({
        version: 1,
        generatedAt: new Date().toISOString(),
        filters: {
            variants: ['standard'],
            timeClasses: ['blitz', 'rapid'],
            maxPlies: 120,
        },
        sources: authorizedSources.map((source) => ({ ...source })),
        games,
    });
    fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
    fs.writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
    const counts = Object.fromEntries(
        ['chesscom:blitz', 'chesscom:rapid', 'lichess:blitz', 'lichess:rapid'].map(
            (key) => [
                key,
                corpus.games.filter(
                    (game) => `${game.provider}:${game.timeClass}` === key
                ).length,
            ]
        )
    );
    console.log(JSON.stringify({ corpusPath, games: corpus.games.length, counts }));
}

class CountingEngine implements StockfishEngine {
    readonly cost: EngineCost = {
        searches: 0,
        evalSearches: 0,
        multiPvSearches: 0,
        requestedNodes: 0,
        largestMultiPv: 1,
    };

    constructor(private readonly engine: ServerStockfishClient) {}

    private record(
        kind: 'eval' | 'multipv',
        options: AnalysisLimit & { multiPv?: number }
    ) {
        this.cost.searches += 1;
        this.cost.requestedNodes += options.nodes ?? 0;
        if (kind === 'eval') this.cost.evalSearches += 1;
        else this.cost.multiPvSearches += 1;
        this.cost.largestMultiPv = Math.max(
            this.cost.largestMultiPv,
            options.multiPv ?? 1
        );
    }

    evalPosition(options: AnalysisLimit & { fen: string }): Promise<EvalResult> {
        this.record('eval', options);
        return this.engine.evalPosition(options);
    }

    analyzeMultiPv(
        options: AnalysisLimit & { fen: string; multiPv?: number }
    ): Promise<MultiPvResult> {
        this.record('multipv', options);
        return this.engine.analyzeMultiPv(options);
    }

    getIdentity() {
        return this.engine.getIdentity();
    }

    terminate() {
        this.engine.terminate();
    }
}

function increment(target: Record<string, number>, key: string, count = 1) {
    target[key] = (target[key] ?? 0) + count;
}

function addCost(target: EngineCost, source: EngineCost) {
    target.searches += source.searches;
    target.evalSearches += source.evalSearches;
    target.multiPvSearches += source.multiPvSearches;
    target.requestedNodes += source.requestedNodes;
    target.largestMultiPv = Math.max(
        target.largestMultiPv,
        source.largestMultiPv
    );
}

async function runProfile(
    corpus: QualityCorpus,
    profile: Profile
): Promise<ProfileRun> {
    const games: GameRun[] = [];
    for (const [index, game] of corpus.games.entries()) {
        const startedAt = performance.now();
        const engine = new CountingEngine(
            new ServerStockfishClient({
                defaultNodes: profile.nodesPerPosition,
                defaultTimeoutMs: 60_000,
            })
        );
        try {
            const output = await extractTrainingMomentsFromGames({
                games: [game],
                selectedGameIds: new Set([game.id]),
                usernameByProvider:
                    game.provider === 'lichess'
                        ? { lichess: 'aldicigg' }
                        : { chesscom: 'adam1a4' },
                engine,
                options: {
                    returnAnalysis: true,
                    nodesPerPosition: profile.nodesPerPosition,
                    confirmNodes: profile.confirmNodes,
                    maxConfirmationNodes: profile.maxConfirmationNodes,
                    verificationNodesPerPosition:
                        profile.verificationNodesPerPosition,
                    multiPv: 5,
                    maxMultiPv: 16,
                    maxAcceptedMoves: 16,
                },
            });
            const manifest = output.manifests[0];
            const analysis = output.analysis?.get(game.id);
            games.push({
                gameId: game.id,
                provider: game.provider,
                timeClass: game.timeClass,
                playedAt: game.playedAt,
                complete: manifest?.complete === true,
                manifestErrors: manifest?.errors ?? ['Missing manifest'],
                wallTimeMs: Math.round(performance.now() - startedAt),
                cost: { ...engine.cost },
                moments: output.moments.map((moment) => ({
                    key: `${game.id}:${moment.decisionPly}`,
                    decisionPly: moment.decisionPly,
                    trainable: moment.solution.trainable,
                    sourceKinds: moment.sourceKinds,
                    verificationStatus:
                        moment.solution.verificationStatus,
                    solutionShape: moment.solution.solutionShape,
                    bestMoveUci: moment.solution.bestMoveUci,
                    acceptedMovesUci:
                        moment.solution.acceptedMovesUci.slice().sort(),
                })),
                extractionReceipt:
                    analysis?.trainingExtraction ?? null,
                receiptReasons:
                    analysis?.trainingExtraction.summary.reasons ?? {},
            });
        } finally {
            engine.terminate();
        }
        console.log(
            `[${profile.name}] ${index + 1}/${corpus.games.length} ${game.id}`
        );
    }

    const totals: ProfileRun['totals'] = {
        games: games.length,
        completedGames: games.filter((game) => game.complete).length,
        candidates: 0,
        moments: 0,
        wallTimeMs: 0,
        cost: {
            searches: 0,
            evalSearches: 0,
            multiPvSearches: 0,
            requestedNodes: 0,
            largestMultiPv: 1,
        },
        verificationStatuses: {},
        receiptReasons: {},
    };
    for (const game of games) {
        totals.candidates += game.moments.length;
        totals.moments += game.moments.filter(
            (moment) => moment.trainable
        ).length;
        totals.wallTimeMs += game.wallTimeMs;
        addCost(totals.cost, game.cost);
        for (const moment of game.moments) {
            increment(totals.verificationStatuses, moment.verificationStatus);
        }
        for (const [reason, count] of Object.entries(game.receiptReasons)) {
            increment(totals.receiptReasons, reason, count);
        }
    }
    return { profile, games, totals };
}

function jaccard(left: string[], right: string[]): number {
    const a = new Set(left);
    const b = new Set(right);
    const union = new Set([...a, ...b]);
    if (union.size === 0) return 1;
    return [...a].filter((value) => b.has(value)).length / union.size;
}

function compare(product: ProfileRun, reference: ProfileRun) {
    const productMoments = new Map(
        product.games.flatMap((game) =>
            game.moments
                .filter((moment) => moment.trainable)
                .map((moment) => [moment.key, moment] as const)
        )
    );
    const referenceMoments = new Map(
        reference.games.flatMap((game) =>
            game.moments
                .filter((moment) => moment.trainable)
                .map((moment) => [moment.key, moment] as const)
        )
    );
    const sharedKeys = [...productMoments.keys()].filter((key) =>
        referenceMoments.has(key)
    );
    const productOnly = [...productMoments.keys()].filter(
        (key) => !referenceMoments.has(key)
    );
    const referenceOnly = [...referenceMoments.keys()].filter(
        (key) => !productMoments.has(key)
    );
    const sharedDetails = sharedKeys.map((key) => {
        const productMoment = productMoments.get(key)!;
        const referenceMoment = referenceMoments.get(key)!;
        const exactBestMove =
            productMoment.bestMoveUci === referenceMoment.bestMoveUci;
        const bestMovesCompatible =
            productMoment.acceptedMovesUci.includes(
                referenceMoment.bestMoveUci
            ) &&
            referenceMoment.acceptedMovesUci.includes(
                productMoment.bestMoveUci
            );
        return {
            key,
            productBestMoveUci: productMoment.bestMoveUci,
            referenceBestMoveUci: referenceMoment.bestMoveUci,
            exactBestMove,
            bestMovesCompatible,
            acceptedMoveJaccard: jaccard(
                productMoment.acceptedMovesUci,
                referenceMoment.acceptedMovesUci
            ),
        };
    });
    const bestMoveAgreements = sharedDetails.filter(
        (detail) => detail.exactBestMove
    ).length;
    const bestMoveCompatibility = sharedDetails.filter(
        (detail) => detail.bestMovesCompatible
    ).length;
    const acceptedMoveJaccard = sharedDetails.map(
        (detail) => detail.acceptedMoveJaccard
    );
    return {
        sharedMoments: sharedKeys.length,
        productOnly,
        referenceOnly,
        referenceCoverage:
            referenceMoments.size === 0
                ? 1
                : sharedKeys.length / referenceMoments.size,
        productAgreement:
            productMoments.size === 0
                ? 1
                : sharedKeys.length / productMoments.size,
        bestMoveAgreement:
            sharedKeys.length === 0
                ? 1
                : bestMoveAgreements / sharedKeys.length,
        bestMoveCompatibility:
            sharedKeys.length === 0
                ? 1
                : bestMoveCompatibility / sharedKeys.length,
        meanAcceptedMoveJaccard:
            acceptedMoveJaccard.length === 0
                ? 1
                : acceptedMoveJaccard.reduce((sum, value) => sum + value, 0) /
                  acceptedMoveJaccard.length,
        bestMoveDisagreements: sharedDetails.filter(
            (detail) => !detail.exactBestMove
        ),
        acceptedMoveDisagreements: sharedDetails.filter(
            (detail) => detail.acceptedMoveJaccard < 1
        ),
    };
}

function percent(value: number) {
    return `${(value * 100).toFixed(1)}%`;
}

function markdownReport(report: {
    mode: string;
    corpus: { games: number; generatedAt: string };
    product: ProfileRun;
    reference: ProfileRun;
    comparison: ReturnType<typeof compare>;
}) {
    const { comparison } = report;
    return `# Extraction quality report\n\n` +
        `- Mode: ${report.mode}\n` +
        `- Corpus: ${report.corpus.games} blitz/rapid games (${report.corpus.generatedAt})\n` +
        `- Product candidates: ${report.product.totals.candidates}\n` +
        `- Product moments: ${report.product.totals.moments}\n` +
        `- Reference candidates: ${report.reference.totals.candidates}\n` +
        `- Reference moments: ${report.reference.totals.moments}\n` +
        `- Shared moments: ${comparison.sharedMoments}\n` +
        `- Reference coverage: ${percent(comparison.referenceCoverage)}\n` +
        `- Product agreement: ${percent(comparison.productAgreement)}\n` +
        `- Best-move agreement: ${percent(comparison.bestMoveAgreement)}\n` +
        `- Best-move compatibility: ${percent(comparison.bestMoveCompatibility)}\n` +
        `- Accepted-move similarity: ${percent(comparison.meanAcceptedMoveJaccard)}\n` +
        `- Product-only decisions: ${comparison.productOnly.join(', ') || 'none'}\n` +
        `- Reference-only decisions: ${comparison.referenceOnly.join(', ') || 'none'}\n`;
}

function confirmationMarkdown(report: {
    corpus: { games: number; generatedAt: string };
    product: ProfileRun;
    candidate: ProfileRun;
    comparison: ReturnType<typeof compare>;
}) {
    const { comparison, product, candidate } = report;
    const productUnresolved =
        product.totals.receiptReasons.VERIFICATION_UNSTABLE ?? 0;
    const candidateUnresolved =
        candidate.totals.receiptReasons.VERIFICATION_UNSTABLE ?? 0;
    const costRatio =
        product.totals.cost.requestedNodes === 0
            ? 1
            : candidate.totals.cost.requestedNodes /
              product.totals.cost.requestedNodes;
    return `# Confirmation-cap experiment\n\n` +
        `- Corpus: ${report.corpus.games} balanced blitz/rapid games (${report.corpus.generatedAt})\n` +
        `- Product cap: ${product.profile.maxConfirmationNodes.toLocaleString('en-US')} nodes\n` +
        `- Candidate cap: ${candidate.profile.maxConfirmationNodes.toLocaleString('en-US')} nodes\n` +
        `- Product moments: ${product.totals.moments}\n` +
        `- Candidate moments: ${candidate.totals.moments}\n` +
        `- Product unresolved: ${productUnresolved}\n` +
        `- Candidate unresolved: ${candidateUnresolved}\n` +
        `- Candidate requested-node ratio: ${costRatio.toFixed(2)}x\n` +
        `- Shared moments: ${comparison.sharedMoments}\n` +
        `- Candidate coverage by product: ${percent(comparison.referenceCoverage)}\n` +
        `- Product coverage by candidate: ${percent(comparison.productAgreement)}\n` +
        `- Best-move compatibility: ${percent(comparison.bestMoveCompatibility)}\n` +
        `- Accepted-move similarity: ${percent(comparison.meanAcceptedMoveJaccard)}\n` +
        `- Product-only decisions: ${comparison.productOnly.join(', ') || 'none'}\n` +
        `- Candidate-only decisions: ${comparison.referenceOnly.join(', ') || 'none'}\n`;
}

async function runLab(mode: 'smoke' | 'full', requestedLimit: number | null) {
    const raw = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as QualityCorpus;
    const validated = validateCorpus(raw);
    const limit = requestedLimit ?? (mode === 'smoke' ? 2 : validated.games.length);
    const corpus = {
        ...validated,
        games: sampleCorpusGames(validated.games, limit),
    };
    const product: Profile =
        mode === 'smoke'
            ? {
                  name: 'product',
                  nodesPerPosition: 5_000,
                  confirmNodes: 10_000,
                  maxConfirmationNodes: 40_000,
                  verificationNodesPerPosition: 5_000,
              }
            : {
                  name: 'product',
                  nodesPerPosition: 100_000,
                  confirmNodes: 200_000,
                  maxConfirmationNodes: 800_000,
                  verificationNodesPerPosition: 100_000,
              };
    const reference: Profile =
        mode === 'smoke'
            ? {
                  name: 'reference',
                  nodesPerPosition: 20_000,
                  confirmNodes: 40_000,
                  maxConfirmationNodes: 160_000,
                  verificationNodesPerPosition: 20_000,
              }
            : {
                  name: 'reference',
                  nodesPerPosition: 400_000,
                  confirmNodes: 800_000,
                  maxConfirmationNodes: 3_200_000,
                  verificationNodesPerPosition: 400_000,
              };
    const productRun = await runProfile(corpus, product);
    const referenceRun = await runProfile(corpus, reference);
    const report = {
        version: 1,
        generatedAt: new Date().toISOString(),
        mode,
        corpus: {
            path: path.relative(repositoryRoot, corpusPath),
            generatedAt: corpus.generatedAt,
            games: corpus.games.length,
            providers: [...new Set(corpus.games.map((game) => game.provider))],
            timeClasses: [...new Set(corpus.games.map((game) => game.timeClass))],
        },
        product: productRun,
        reference: referenceRun,
        comparison: compare(productRun, referenceRun),
    };
    fs.mkdirSync(reportDirectory, { recursive: true });
    const jsonPath = path.join(reportDirectory, `${mode}.json`);
    const markdownPath = path.join(reportDirectory, `${mode}.md`);
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(markdownPath, markdownReport(report));
    console.log(JSON.stringify({ jsonPath, markdownPath, comparison: report.comparison }));
}

async function runConfirmationExperiment(requestedLimit: number | null) {
    const raw = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as QualityCorpus;
    const validated = validateCorpus(raw);
    const limit = requestedLimit ?? 8;
    const corpus = {
        ...validated,
        games: sampleCorpusGames(validated.games, limit),
    };
    const product: Profile = {
        name: 'product',
        nodesPerPosition: 100_000,
        confirmNodes: 200_000,
        maxConfirmationNodes: 800_000,
        verificationNodesPerPosition: 100_000,
    };
    const candidate: Profile = {
        ...product,
        name: 'confirmation-candidate',
        maxConfirmationNodes: 1_600_000,
    };
    const productRun = await runProfile(corpus, product);
    const candidateRun = await runProfile(corpus, candidate);
    const report = {
        version: 1,
        generatedAt: new Date().toISOString(),
        mode: 'confirmation',
        corpus: {
            path: path.relative(repositoryRoot, corpusPath),
            generatedAt: corpus.generatedAt,
            games: corpus.games.length,
            providers: [...new Set(corpus.games.map((game) => game.provider))],
            timeClasses: [
                ...new Set(corpus.games.map((game) => game.timeClass)),
            ],
        },
        product: productRun,
        candidate: candidateRun,
        comparison: compare(productRun, candidateRun),
    };
    fs.mkdirSync(reportDirectory, { recursive: true });
    const jsonPath = path.join(reportDirectory, 'confirmation.json');
    const markdownPath = path.join(reportDirectory, 'confirmation.md');
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(markdownPath, confirmationMarkdown(report));
    console.log(
        JSON.stringify({
            jsonPath,
            markdownPath,
            comparison: report.comparison,
        })
    );
}

export async function main(args: string[]) {
    const parsed = parseArgs(args);
    if (parsed.command === 'refresh') {
        await refreshCorpus();
        return;
    }
    if (parsed.command === 'confirmation') {
        await runConfirmationExperiment(parsed.limit);
        return;
    }
    await runLab(parsed.command, parsed.limit);
}
