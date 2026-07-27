import { PrismaClient } from '@prisma/client';

import { E2E_USER } from './fixtures';

export async function resetE2ePuzzleAttempts() {
    const prisma = new PrismaClient();
    try {
        await prisma.puzzleAttempt.deleteMany({
            where: { userId: E2E_USER.id },
        });
    } finally {
        await prisma.$disconnect();
    }
}
