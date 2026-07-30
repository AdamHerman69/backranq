import { createSerwistRoute } from '@serwist/turbopack';

export const {
    dynamic,
    dynamicParams,
    revalidate,
    generateStaticParams,
    GET,
} = createSerwistRoute({
    additionalPrecacheEntries: [
        { url: '/~offline/coach', revision: 'coach-offline-shell-v1' },
    ],
    maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
    swSrc: 'src/app/sw.ts',
    useNativeEsbuild: true,
});
