import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    test: {
        clearMocks: true,
        environment: 'node',
        globals: false,
        include: ['tests/**/*.test.ts'],
        mockReset: true,
        restoreMocks: true,
        root: rootDir,
        setupFiles: ['./tests/setup.ts'],
    },
});
