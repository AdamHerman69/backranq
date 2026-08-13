#!/usr/bin/env node

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const transcript = [];
let appOutput = '';
const queueServer = http.createServer((request, response) => {
    transcript.push({ method: request.method, url: request.url });
    request.resume();
    request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
    });
});

await listen(queueServer, 0);
const queueAddress = queueServer.address();
if (!queueAddress || typeof queueAddress === 'string') {
    throw new Error('Could not resolve the Queue smoke server address.');
}
const appPort = await freePort();
const childEnv = { ...process.env };
for (const name of [
    'VERCEL',
    'VERCEL_ENV',
    'VERCEL_DEPLOYMENT_ID',
    'VERCEL_OIDC_TOKEN',
]) {
    delete childEnv[name];
}
Object.assign(childEnv, {
    NODE_ENV: 'production',
    PORT: String(appPort),
    HOSTNAME: '127.0.0.1',
    NEXTAUTH_SECRET: 'queue-runtime-smoke-secret',
    AUTH_SECRET: 'queue-runtime-smoke-secret',
    DATABASE_URL: 'postgresql://backranq:backranq@127.0.0.1:9/backranq_smoke',
    DIRECT_URL: 'postgresql://backranq:backranq@127.0.0.1:9/backranq_smoke',
    BACKRANQ_QUEUE_SMOKE_MODE: 'true',
    BACKRANQ_QUEUE_SMOKE_BASE_URL: `http://127.0.0.1:${queueAddress.port}`,
    BACKRANQ_DISABLE_VERCEL_QUEUE: 'false',
});

const app = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(appPort)],
    { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
);
for (const stream of [app.stdout, app.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        appOutput += chunk;
        process.stderr.write(chunk);
    });
}

try {
    await waitForHttp(`http://127.0.0.1:${appPort}/api/health`);
    const response = await fetch(
        `http://127.0.0.1:${appPort}/api/queues/backranq-jobs`,
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'ce-type': 'com.vercel.queue.v2beta',
                'ce-vqsqueuename': 'backranq-jobs',
                'ce-vqsconsumergroup': 'backranq-runtime-smoke',
                'ce-vqsmessageid': 'runtime-smoke-message',
                'ce-vqsreceipthandle': 'runtime-smoke-receipt',
                'ce-vqsdeliverycount': '1',
                'ce-vqsregion': 'iad1',
            },
            body: JSON.stringify({ type: 'runtime-smoke' }),
            signal: AbortSignal.timeout(30_000),
        }
    );
    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Compiled Queue callback returned ${response.status}: ${body}`);
    }
    const acknowledgement = transcript.find(
        (entry) =>
            entry.method === 'DELETE' &&
            entry.url?.includes('/api/v3/topic/backranq-jobs/consumer/') &&
            entry.url.endsWith('/lease/runtime-smoke-receipt')
    );
    if (!acknowledgement) {
        throw new Error(`Queue callback did not acknowledge its lease: ${JSON.stringify(transcript)}`);
    }
    for (const signature of [
        /fetch is not a function/i,
        /Stockfish changed the parent fetch binding/i,
        /Failed to acknowledge message/i,
        /Queue callback error/i,
    ]) {
        if (signature.test(appOutput)) {
            throw new Error(`Queue runtime emitted a forbidden error signature: ${signature}`);
        }
    }
    console.log('Compiled Queue callback started Stockfish and acknowledged through the loopback VQS stub.');
} finally {
    app.kill('SIGTERM');
    await Promise.race([
        new Promise((resolve) => app.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await close(queueServer);
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
}

function close(server) {
    return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
    );
}

function freePort() {
    const server = net.createServer();
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Could not reserve an application port.'));
                return;
            }
            server.close((error) =>
                error ? reject(error) : resolve(address.port)
            );
        });
    });
}

async function waitForHttp(url) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (app.exitCode !== null) {
            throw new Error(`next start exited early (${app.exitCode}).\n${appOutput}`);
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
            if (response.ok) return;
        } catch {
            // The production server is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for next start.\n${appOutput}`);
}
