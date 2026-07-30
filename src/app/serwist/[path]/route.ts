import { createSerwistRoute } from '@serwist/turbopack';

import { resolveCoachOfflineShellRevision } from '@/lib/coach/offlineRevision';

const offlineShellRevision =
    resolveCoachOfflineShellRevision(process.env);

export const {
    dynamic,
    dynamicParams,
    revalidate,
    generateStaticParams,
    GET,
} = createSerwistRoute({
    additionalPrecacheEntries: [
        {
            url: '/~offline/coach',
            // Every deployed commit gets a new cache key. This prevents an old
            // offline HTML shell from pointing at chunks removed by a newer SW.
            revision: `coach-offline-shell-${offlineShellRevision}`,
        },
    ],
    // Maia is an explicit, roughly 56 MiB opt-in download. Keep its local
    // ONNX Runtime assets out of the install-time coach precache and let the
    // runtime route cache them only after the user selects Maia.
    globIgnores: ['public/vendor/maia/**/*'],
    maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
    swSrc: 'src/app/sw.ts',
    useNativeEsbuild: true,
});
