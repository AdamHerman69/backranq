import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.BACKRANQ_E2E_PORT ?? '3100');
const baseURL =
    process.env.BACKRANQ_E2E_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
    testDir: './tests/e2e',
    testMatch: [
        'coach.spec.ts',
        'coach-offline.spec.ts',
        'coach-maia-model.live.spec.ts',
    ],
    fullyParallel: false,
    workers: 1,
    timeout: 90_000,
    expect: { timeout: 20_000 },
    reporter: [['list']],
    use: {
        ...devices['Desktop Chrome'],
        baseURL,
        viewport: { width: 1440, height: 1000 },
        trace: 'retain-on-failure',
    },
    webServer: {
        command: `pnpm start --hostname localhost --port ${port}`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            NEXTAUTH_URL: baseURL,
            BACKRANQ_APP_URL: baseURL,
        },
    },
    projects: [
        {
            name: 'offline-production-chromium',
            use: {
                ...devices['Desktop Chrome'],
            },
        },
    ],
});
