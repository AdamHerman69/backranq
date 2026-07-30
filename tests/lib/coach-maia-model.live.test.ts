import { createHash } from 'node:crypto';

import * as ort from 'onnxruntime-web/wasm';
import { describe, expect, it } from 'vitest';

import { MAIA_MODEL } from '@/lib/coach/maia/metadata';
import { prepareMaiaPosition } from '@/lib/coach/maia/preprocess';
import { sampleMaiaPolicy } from '@/lib/coach/maia/sampling';

const runLiveModel = process.env.RUN_MAIA_MODEL_SMOKE === '1';

describe.skipIf(!runLiveModel)('official Maia ONNX smoke', () => {
    it(
        'verifies the pinned model and maps a golden start-position inference to a legal UCI move',
        async () => {
            const response = await fetch(MAIA_MODEL.sourceUrl);
            expect(response.ok).toBe(true);
            const bytes = await response.arrayBuffer();
            expect(bytes.byteLength).toBe(MAIA_MODEL.byteLength);
            expect(
                createHash('sha256')
                    .update(new Uint8Array(bytes))
                    .digest('hex')
            ).toBe(MAIA_MODEL.sha256);

            ort.env.wasm.numThreads = 1;
            const session = await ort.InferenceSession.create(bytes, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all',
            });
            const position = prepareMaiaPosition(
                'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
            );
            const outputs = await session.run({
                tokens: new ort.Tensor(
                    'float32',
                    position.tokens,
                    [1, 64, 12]
                ),
                elo_self: new ort.Tensor(
                    'float32',
                    Float32Array.of(1_600),
                    [1]
                ),
                elo_oppo: new ort.Tensor(
                    'float32',
                    Float32Array.of(1_600),
                    [1]
                ),
            });
            const policy = outputs.logits_move;
            expect(policy?.data).toHaveLength(4_352);

            const sample = sampleMaiaPolicy({
                logits: policy!.data as ArrayLike<number>,
                legalMoves: position.legalMoves,
                seed: 42,
                temperature: MAIA_MODEL.sampling.temperature,
                topP: MAIA_MODEL.sampling.topP,
            });

            // This golden value catches board orientation, move-vocabulary and
            // sampling drift against the exact pinned model bytes.
            expect(sample.moveUci).toBe('e2e4');
            expect(
                position.legalMoves.map((move) => move.moveUci)
            ).toContain(sample.moveUci);
        },
        180_000
    );
});
