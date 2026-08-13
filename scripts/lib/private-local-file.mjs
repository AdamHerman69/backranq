import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function writePrivateLocalJson(outputDirectory, filename, value) {
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(outputDirectory, 0o700);

    const outputPath = path.join(outputDirectory, filename);
    const temporaryPath = path.join(
        outputDirectory,
        `.${filename}.${process.pid}.${randomUUID()}.tmp`
    );

    try {
        fs.writeFileSync(
            temporaryPath,
            `${JSON.stringify(value, null, 2)}\n`,
            { flag: 'wx', mode: 0o600 }
        );
        fs.chmodSync(temporaryPath, 0o600);
        fs.renameSync(temporaryPath, outputPath);
        fs.chmodSync(outputPath, 0o600);
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }

    return outputPath;
}
