import { PrismaClient } from '@prisma/client';

import { E2E_USER } from './fixtures';

export async function resetE2eTrainingAttempts() {
    const prisma = new PrismaClient();
    try {
        await prisma.trainingAttempt.deleteMany({
            where: { userId: E2E_USER.id },
        });
    } finally {
        await prisma.$disconnect();
    }
}
