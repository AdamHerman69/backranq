import fs from 'node:fs';
import path from 'node:path';

export function loadEnvFiles(cwd = process.cwd()) {
    for (const name of ['.env', '.env.local']) {
        const file = path.join(cwd, name);
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (!match) continue;
            const [, key, rawValue] = match;
            if (process.env[key] != null) continue;
            process.env[key] = unquote(rawValue.trim());
        }
    }
}

function unquote(value) {
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        return value.slice(1, -1);
    }
    return value;
}
