const unexpectedRuntimeSignatures = [
    {
        id: 'node-fetch-runtime-mismatch',
        pattern: /\bfetch is not a function\b/i,
    },
    {
        id: 'prisma-transaction-timeout',
        pattern:
            /\bP2028\b|Unable to start a transaction in the given time|Transaction API error/i,
    },
    {
        id: 'unhandled-rejection',
        pattern:
            /\bunhandled(?:Promise)?Rejection\b|\bunhandled promise rejection\b/i,
    },
    {
        id: 'uncaught-exception',
        pattern: /\buncaughtException\b|\buncaught exception\b/i,
    },
    {
        id: 'auth-runtime-error',
        pattern: /\[auth\]\[error\]|\b(?:AdapterError|AuthError):/i,
    },
    {
        id: 'prisma-runtime-error',
        pattern:
            /\bPrismaClient(?:KnownRequest|UnknownRequest|Initialization|RustPanic|Validation)Error\b|\bP[12]\d{3}\b/i,
    },
    {
        id: 'database-runtime-error',
        pattern:
            /Can't reach database server|Authentication failed against database server|Error querying the database|Timed out fetching a new connection from the connection pool/i,
    },
];

// Fatal runtime signatures are intentionally not allowlisted today. Add only
// exact, reviewed lines here when a browser journey deliberately exercises and
// asserts a server-side failure; never allowlist a broad error class.
const allowedRuntimeLogLines = [];

export function findUnexpectedRuntimeLogSignatures(output) {
    const findings = [];
    const seen = new Set();

    for (const rawLine of String(output).split(/\r?\n/)) {
        const line = stripAnsi(rawLine).trim();
        if (!line || allowedRuntimeLogLines.some((entry) => entry.pattern.test(line))) {
            continue;
        }

        for (const signature of unexpectedRuntimeSignatures) {
            if (!signature.pattern.test(line)) continue;
            const key = `${signature.id}\0${line}`;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push({ id: signature.id, line });
        }
    }

    return findings;
}

export function formatUnexpectedRuntimeLogFindings(findings) {
    return findings
        .map((finding) => `- ${finding.id}: ${finding.line}`)
        .join('\n');
}

function stripAnsi(value) {
    return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}
