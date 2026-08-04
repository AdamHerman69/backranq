'use client';

import type { ReactNode } from 'react';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { AnalysisDefaults } from '@/lib/preferences';
import {
    ANALYSIS_QUALITY_PROFILES,
    type AnalysisQuality,
} from '@/lib/analysis/quality';
import type {
    TrainingCoveragePreset,
    TrainingGradingTolerance,
} from '@/lib/training/config';

export const TRAINING_COVERAGE_OPTION_LABELS: Record<
    TrainingCoveragePreset,
    string
> = {
    ALL_CONFIRMED: 'Nearly every confirmed position',
    BALANCED: 'Meaningful positions',
    HIGH_CONFIDENCE: 'Major positions only',
};

function Field({
    label,
    hint,
    error,
    children,
}: {
    label: string;
    hint: string;
    error?: string | null;
    children: ReactNode;
}) {
    return (
        <label className="space-y-1">
            <div className="text-sm font-medium">{label}</div>
            {children}
            <div
                className={cn(
                    'text-xs',
                    error ? 'text-destructive' : 'text-muted-foreground'
                )}
                aria-live={error ? 'polite' : undefined}
            >
                {error ?? hint}
            </div>
        </label>
    );
}

function IntentSetting({
    title,
    description,
    children,
    dense,
}: {
    title: string;
    description: string;
    children: ReactNode;
    dense: boolean;
}) {
    return (
        <section
            className={cn(
                'rounded-lg border bg-muted/20',
                dense ? 'space-y-2 p-2.5' : 'space-y-3 p-3'
            )}
        >
            <div>
                <div className="text-sm font-semibold">{title}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                    {description}
                </p>
            </div>
            {children}
        </section>
    );
}

export function analysisDefaultsAreValid(value: AnalysisDefaults): boolean {
    return value.analysisQuality in ANALYSIS_QUALITY_PROFILES;
}

export function AnalysisDefaultsFields({
    value,
    onChange,
    disabled,
    dense = false,
}: {
    value: AnalysisDefaults;
    onChange: (next: AnalysisDefaults) => void;
    disabled?: boolean;
    dense?: boolean;
}) {
    function patch(next: Partial<AnalysisDefaults>) {
        onChange({ ...value, ...next });
    }

    return (
        <div className={cn(dense ? 'space-y-3' : 'space-y-4')}>
            <IntentSetting
                title="Analysis quality"
                description="Quality controls how deeply uncertain positions are verified. Browser analysis is free; server analysis uses the shown credits per game."
                dense={dense}
            >
                <Field
                    label="Quality"
                    hint={ANALYSIS_QUALITY_PROFILES[value.analysisQuality].description}
                >
                    <Select
                        value={value.analysisQuality}
                        onValueChange={(analysisQuality) =>
                            patch({
                                analysisQuality:
                                    analysisQuality as AnalysisQuality,
                            })
                        }
                        disabled={disabled}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="STANDARD">
                                Standard · 7 server credits/game
                            </SelectItem>
                            <SelectItem value="THOROUGH">
                                Thorough · Recommended · 10 server credits/game
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </Field>
            </IntentSetting>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <IntentSetting
                    title="Practice positions to keep"
                    description="Coverage controls which confirmed decisions become practice positions."
                    dense={dense}
                >
                    <Field
                        label="Position coverage"
                        hint="Includes your mistakes and missed opportunities when a game is analyzed again."
                    >
                        <Select
                            value={value.trainingCoveragePreset}
                            onValueChange={(trainingCoveragePreset) =>
                                patch({
                                    trainingCoveragePreset:
                                        trainingCoveragePreset as TrainingCoveragePreset,
                                })
                            }
                            disabled={disabled}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="ALL_CONFIRMED">
                                    {
                                        TRAINING_COVERAGE_OPTION_LABELS.ALL_CONFIRMED
                                    }
                                </SelectItem>
                                <SelectItem value="BALANCED">
                                    {TRAINING_COVERAGE_OPTION_LABELS.BALANCED}
                                </SelectItem>
                                <SelectItem value="HIGH_CONFIDENCE">
                                    {
                                        TRAINING_COVERAGE_OPTION_LABELS.HIGH_CONFIDENCE
                                    }
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </Field>
                </IntentSetting>

                <IntentSetting
                    title="Moves to accept"
                    description="Tolerance grades your answer; it never removes saved practice positions."
                    dense={dense}
                >
                    <Field
                        label="Accepted-move tolerance"
                        hint="Moves are judged by practical outcome, not exact engine equality."
                    >
                        <Select
                            value={value.trainingGradingTolerance}
                            onValueChange={(trainingGradingTolerance) =>
                                patch({
                                    trainingGradingTolerance:
                                        trainingGradingTolerance as TrainingGradingTolerance,
                                })
                            }
                            disabled={disabled}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="STRICT">Strict</SelectItem>
                                <SelectItem value="PRACTICAL">
                                    Practical
                                </SelectItem>
                                <SelectItem value="LENIENT">Lenient</SelectItem>
                            </SelectContent>
                        </Select>
                    </Field>
                </IntentSetting>
            </div>

            {dense ? null : (
                <p className="text-xs text-muted-foreground">
                    New grading tolerances are stored in each solution
                    revision, so historical attempts keep their original
                    policy.
                </p>
            )}
        </div>
    );
}
