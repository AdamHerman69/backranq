import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
    canonicalPreferences,
} from '@/lib/preferences';
import { getAnalysisJobCounts } from '@/lib/services/analysisJobs';
import { getManualServerAnalysisCapacity } from '@/lib/games/serverAnalysisCapacity';
import { getAutoAnalysisStatus } from '@/lib/services/autoAnalysisBacklog';

export const runtime = 'nodejs';

export async function GET() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const lichessLatest = await prisma.analyzedGame.findFirst({
        where: { userId, provider: 'LICHESS' },
        orderBy: { playedAt: 'desc' },
        select: { playedAt: true },
    });
    const chesscomLatest = await prisma.analyzedGame.findFirst({
        where: { userId, provider: 'CHESSCOM' },
        orderBy: { playedAt: 'desc' },
        select: { playedAt: true },
    });
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            lichessUsername: true,
            chesscomUsername: true,
            preferences: true,
        },
    });
    const syncStates = await prisma.providerSyncState.findMany({
        where: { userId },
        select: {
            provider: true,
            enabled: true,
            lastSyncedPlayedAt: true,
            lastAttemptAt: true,
            lastSuccessAt: true,
            lastError: true,
        },
    });
    const jobCounts = await getAnalysisJobCounts(userId);
    const [billing, automation] = await Promise.all([
        getManualServerAnalysisCapacity(userId),
        getAutoAnalysisStatus(userId),
    ]);

    const prefs = canonicalPreferences(user?.preferences ?? {});
    const stateByProvider = Object.fromEntries(
        syncStates.map((state) => [
            state.provider === 'LICHESS' ? 'lichess' : 'chesscom',
            {
                enabled: state.enabled,
                lastSyncedPlayedAt:
                    state.lastSyncedPlayedAt?.toISOString() ?? null,
                lastAttemptAt: state.lastAttemptAt?.toISOString() ?? null,
                lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
                lastError: state.lastError,
            },
        ])
    );

    return NextResponse.json({
        ownerId: userId,
        linked: {
            lichessUsername: user?.lichessUsername ?? null,
            chesscomUsername: user?.chesscomUsername ?? null,
        },
        lastSync: {
            lichess: lichessLatest?.playedAt?.toISOString() ?? null,
            chesscom: chesscomLatest?.playedAt?.toISOString() ?? null,
        },
        autoSync: {
            enabled: prefs.autoSyncEnabled,
            providers: prefs.autoSyncProviders,
            schedule: '0 3 * * *',
            states: {
                lichess: stateByProvider.lichess ?? null,
                chesscom: stateByProvider.chesscom ?? null,
            },
        },
        analysisJobs: {
            queued: jobCounts.queued,
            running: jobCounts.running,
            failed: jobCounts.failed,
        },
        billing,
        inventory: automation.inventory,
        automation: {
            policy: automation.policy,
            backlog: automation.backlog,
            capacity: automation.capacity,
        },
    });
}
