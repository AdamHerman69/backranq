import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';

const directory = path.resolve(process.argv[2] ?? 'artifacts/extraction-quality-lab/audit');
const documents = fs.readdirSync(directory).filter((name) => /^(product|reference|confirmation-candidate)-/.test(name)).map((name) => ({ name, data: JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) }));
for (const field of ['head', 'corpusSha256', 'auditRunId']) {
    if (new Set(documents.map(({ data }) => data[field] ?? null)).size > 1) throw new Error(`Mixed audit runs: ${field}`);
}
const summaries = [];
const review = ['# Representative decision evidence', '', 'Generated from the optional quality-lab audit. Decision ply is zero-based; move labels below are SAN. These are engine observations, not human quality labels. WDL loss is expected-score loss, not human winning probability.', ''];
for (const { name, data } of documents) {
    const phases = {};
    const duplicates = new Map();
    const roots = new Set((data.output?.moments ?? []).map((moment) => moment.fen));
    for (const call of data.calls) {
        const caller = call.caller.join(' ');
        const phase = caller.includes('confirmCandidate') ? 'loss-confirmation' : caller.includes('evaluatePlayedMoveLoss') ? 'opportunity-lookahead' : call.kind === 'multipv' && call.caller.includes('build') ? (roots.has(call.fen) ? 'solution-root-frontier' : 'solution-nonroot-continuation') : 'scan';
        const item = phases[phase] ??= { calls: 0, requestedNodes: 0, reportedNodes: 0, wallTimeMs: 0 };
        item.calls += 1;
        item.requestedNodes += call.requestedNodes ?? 0;
        item.reportedNodes += call.reportedNodes;
        item.wallTimeMs += call.wallTimeMs;
        const key = `${call.kind}:${call.fen}:${call.requestedNodes}:${call.multiPv}`;
        duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
    }
    const moments = (data.output?.moments ?? []).map((moment) => {
        const san = (uci) => { try { return new Chess(moment.fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined }).san; } catch { return uci; } };
        return {
            decisionPly: moment.decisionPly, fen: moment.fen, sourceKinds: moment.sourceKinds,
            played: san(moment.originalMoveUci), best: san(moment.solution.manifest.rootAnswerIndex.preferredMoveUci),
            accepted: moment.solution.manifest.assessments.filter(a => a.quality === 'GOOD' && a.qualitySupport === 'SUPPORTED').map(a => a.moveUci).map(san),
            originalLossCp: moment.originalDecision.cpLoss,
            originalLossExpectedScore: moment.originalDecision.winChanceLoss,
            trainable: moment.solution.manifest.decision.selection === 'INCLUDED',
            verification: moment.solution.manifest.decision.status,
            frontier: moment.solution.manifest.rootAnswerIndex.readiness,
            playedAccepted: moment.solution.manifest.assessments.filter(a => a.quality === 'GOOD' && a.qualitySupport === 'SUPPORTED').map(a => a.moveUci).includes(moment.originalMoveUci),
            diagnostics: [moment.solution.manifest.decision.reason],
        };
    });
    summaries.push({ name, startupMs: data.startupMs, totalMs: data.totalMs, phases,
        repeatedIdenticalRequests: [...duplicates.values()].reduce((sum, count) => sum + count - 1, 0),
        manifests: data.output?.manifests, moments,
        receipts: Object.values(data.output?.analysis ?? {}).map((analysis) => analysis.trainingExtraction),
    });
    review.push(`## ${name}`, '', '| Ply | Played | Best | Original-decision cp loss | Trainable | Status / frontier | Accepted SAN |', '| --- | --- | --- | ---: | --- | --- | --- |');
    for (const moment of moments) review.push(`| ${moment.decisionPly} | ${moment.played} | ${moment.best} | ${moment.originalLossCp ?? '—'} | ${moment.trainable} | ${moment.verification} / ${moment.frontier} | ${moment.accepted.join(', ')} |`);
    review.push('');
    for (const moment of moments) review.push(`### Ply ${moment.decisionPly}: ${moment.played}`, '', `FEN: \`${moment.fen}\``, '', '```text', new Chess(moment.fen).ascii(), '```', '', `Diagnostics: ${moment.diagnostics.join('; ') || 'none'}. Played move accepted: ${moment.playedAccepted}.`, '', 'Human review: Is the best idea understandable? Which alternatives should count as success? Would replaying this decision teach something useful?', '');
}
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summaries, null, 2) + '\n');
fs.writeFileSync(path.join(directory, 'positions.md'), review.join('\n'));
const comparison = [];
for (const product of summaries.filter((item) => item.name.startsWith('product-'))) {
    const reference = summaries.find((item) => item.name === product.name.replace(/^product-/, 'reference-'));
    if (!reference) continue;
    for (const ply of new Set([...product.moments, ...reference.moments].map((moment) => moment.decisionPly))) {
        const left = product.moments.find((moment) => moment.decisionPly === ply);
        const right = reference.moments.find((moment) => moment.decisionPly === ply);
        const receipt = (run) => run.receipts.flatMap((item) => item?.decisions ?? []).find((decision) => decision.ply === ply);
        comparison.push({ game: product.name.slice(8), ply, product: left ?? receipt(product), reference: right ?? receipt(reference),
            productAcceptedOnly: left && right ? left.accepted.filter((move) => !right.accepted.includes(move)) : null,
            referenceAcceptedOnly: left && right ? right.accepted.filter((move) => !left.accepted.includes(move)) : null,
        });
    }
}
fs.writeFileSync(path.join(directory, 'candidate-comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
console.log(JSON.stringify(summaries.map(({ name, startupMs, totalMs, phases, moments, repeatedIdenticalRequests }) => ({ name, startupMs, totalMs, phases, repeatedIdenticalRequests, moments })), null, 2));
