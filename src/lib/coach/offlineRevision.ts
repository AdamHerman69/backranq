type BuildEnvironment = Record<string, string | undefined>;

export function resolveCoachOfflineShellRevision(
    environment: BuildEnvironment
): string {
    const githubRunRevision = environment.GITHUB_RUN_ID
        ? `${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT ?? '1'}`
        : undefined;
    return (
        environment.BACKRANQ_BUILD_REVISION ||
        environment.VERCEL_DEPLOYMENT_ID ||
        environment.VERCEL_URL ||
        githubRunRevision ||
        environment.VERCEL_GIT_COMMIT_SHA ||
        environment.GITHUB_SHA ||
        environment.SOURCE_VERSION ||
        // Non-Vercel production builds should always provide
        // BACKRANQ_BUILD_REVISION (their immutable deployment/build ID).
        `local-${environment.npm_package_version ?? 'development'}`
    );
}
