'use client';

import type { TrainingPromptDto } from '@/lib/training/api';
import { usePuzzleSession } from '@/lib/hooks/usePuzzleSession';

/**
 * Anonymous onboarding adapter. All chess behavior lives in the shared puzzle
 * runtime; this wrapper only selects the public unresolved/engine policy.
 */
export function usePublicPuzzleSession(prompt: TrainingPromptDto) {
    return usePuzzleSession({
        initialPrompt: prompt,
        unresolvedMode: 'REVEAL',
        prewarmEngine: true,
        stopEngineOnTerminal: true,
    });
}
