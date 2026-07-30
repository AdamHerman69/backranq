import { defineConfig, devices } from '@playwright/test';

import { E2E_AUTH_STATE_PATH } from './tests/e2e/support/fixtures';

const port = Number(process.env.BACKRANQ_E2E_PORT ?? '3100');
const baseURL =
    process.env.BACKRANQ_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const dedicatedOfflineCoachTests = [
    '**/coach-offline.spec.ts',
    '**/coach.spec.ts',
    '**/coach-maia-model.live.spec.ts',
];

export default defineConfig({
    testDir: './tests/e2e',
    testMatch: '**/*.spec.ts',
    testIgnore: dedicatedOfflineCoachTests,
    fullyParallel: false,
    workers: 1,
    timeout: 45_000,
    expect: {
        timeout: 8_000,
    },
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI
        ? [['line'], ['html', { open: 'never' }]]
        : [['list'], ['html', { open: 'never' }]],
    globalSetup: './tests/e2e/global-setup.ts',
    use: {
        baseURL,
        storageState: E2E_AUTH_STATE_PATH,
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
    },
    webServer: {
        command: `pnpm dev --hostname 127.0.0.1 --port ${port}`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
            ...process.env,
            NEXTAUTH_URL: baseURL,
            BACKRANQ_APP_URL: baseURL,
        },
    },
    projects: [
        {
            name: 'desktop-chromium',
            testIgnore: [
                '**/mobile.spec.ts',
                ...dedicatedOfflineCoachTests,
            ],
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1440, height: 1000 },
            },
        },
        {
            name: 'mobile-chromium',
            testMatch: '**/mobile.spec.ts',
            use: {
                ...devices['Pixel 7'],
            },
        },
    ],
});
