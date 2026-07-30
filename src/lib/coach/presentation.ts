import type { UserMoveAssessment } from '@/lib/coach/assessment';

export function formatCoachImpact(
    assessment: UserMoveAssessment
): string {
    const parts: string[] = [];
    if (assessment.loss.winningChance != null) {
        parts.push(
            `${Math.round(assessment.loss.winningChance * 100)}% expected-score loss`
        );
    }
    if (
        assessment.loss.cp != null &&
        assessment.loss.cp < 10_000
    ) {
        parts.push(`${(assessment.loss.cp / 100).toFixed(2)} pawns`);
    }
    if (assessment.outcomeReason === 'allowed-forced-mate') {
        parts.push('allowed a forced mate');
    } else if (assessment.outcomeReason === 'lost-forced-mate') {
        parts.push('lost a forced mate');
    }
    return parts.join(' · ') || 'Material change in the position';
}
