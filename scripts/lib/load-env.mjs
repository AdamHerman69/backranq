import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} [cwd]
 * @param {Record<string, string | undefined>} [environment]
 * @param {string} [mode]
 */
export function loadEnvFiles(
    cwd = process.cwd(),
    environment = process.env,
    mode = environment.NODE_ENV ?? 'development'
) {
    for (const name of envFileNames(mode)) {
        const file = path.join(cwd, name);
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (!match) continue;
            const [, key, rawValue] = match;
            if (environment[key] != null) continue;
            environment[key] = unquote(rawValue.trim());
        }
    }
    return environment;
}

/** @param {string | undefined} mode */
export function envFileNames(mode) {
    const normalizedMode = mode?.trim() || 'development';
    return [
        `.env.${normalizedMode}.local`,
        ...(normalizedMode === 'test' ? [] : ['.env.local']),
        `.env.${normalizedMode}`,
        '.env',
    ];
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
