import { afterEach } from 'vitest';
import { resetRouteMocks } from './helpers/route-mocks';

process.env.NEXTAUTH_SECRET ??= 'test-secret';
process.env.NEXTAUTH_URL ??= 'http://localhost:3000';

afterEach(() => {
    resetRouteMocks();
});
