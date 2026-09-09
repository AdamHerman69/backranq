import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export function hash(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}
export function readJson<T>(file: string): T {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
export function atomicJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, file);
}
export function withLock(directory: string): () => void {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'study.lock');
    if (fs.existsSync(file)) {
        const prior = readJson<{ pid: number; host: string }>(file);
        if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0 || prior.host !== os.hostname()) {
            throw new Error(`Foreign/invalid study lock: ${file}. Do not remove while a study is running.`);
        }
        let alive = true;
        try { process.kill(prior.pid, 0); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
        if (alive) throw new Error(`Study already running (PID ${prior.pid}).`);
        fs.unlinkSync(file);
    }
    const token = randomUUID();
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), token }), { flag: 'wx' });
    return () => {
        if (fs.existsSync(file) && readJson<{token:string}>(file).token === token) fs.unlinkSync(file);
    };
}
export function jsonFiles(directory: string): string[] {
    return fs.existsSync(directory)
        ? fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => path.join(directory, name))
        : [];
}
