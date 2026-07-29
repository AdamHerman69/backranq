'use client';

import Link from 'next/link';
import {
    forwardRef,
    useEffect,
    useRef,
    type ComponentProps,
} from 'react';

import type { ProgressAnalyticsWrite } from '@/lib/progress/analytics';
import { recordProgressEvent } from '@/lib/progress/analyticsClient';

type ActionEvent = Extract<
    ProgressAnalyticsWrite,
    { eventName: 'ACTION_CLICKED' }
>;

export type ProgressAnalyticsContext = Pick<
    ProgressAnalyticsWrite,
    'windowDays' | 'provider' | 'timeClass'
>;

function eventIdentity() {
    return {
        clientEventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
    };
}

function recordView(context: ProgressAnalyticsContext) {
    return recordProgressEvent({
        eventName: 'PROGRESS_VIEWED',
        ...eventIdentity(),
        ...context,
    });
}

function recordAction(
    context: ProgressAnalyticsContext,
    actionKey: ActionEvent['actionKey'],
    recommendationKey?: ActionEvent['recommendationKey']
) {
    return recordProgressEvent({
        eventName: 'ACTION_CLICKED',
        ...eventIdentity(),
        ...context,
        actionKey,
        ...(recommendationKey ? { recommendationKey } : {}),
    });
}

export function ProgressViewTracker({
    context,
}: {
    context: ProgressAnalyticsContext;
}) {
    const signature = JSON.stringify(context);
    const lastRecordedSignature = useRef<string | null>(null);

    useEffect(() => {
        if (lastRecordedSignature.current === signature) return;
        lastRecordedSignature.current = signature;
        void recordView(context);
    }, [context, signature]);

    return null;
}

type TrackedProgressLinkProps = ComponentProps<typeof Link> & {
    analyticsContext: ProgressAnalyticsContext;
    actionKey: ActionEvent['actionKey'];
    recommendationKey?: ActionEvent['recommendationKey'];
};

export const TrackedProgressLink = forwardRef<
    HTMLAnchorElement,
    TrackedProgressLinkProps
>(function TrackedProgressLink(
    {
        analyticsContext,
        actionKey,
        recommendationKey,
        onClick,
        ...linkProps
    },
    ref
) {
    return (
        <Link
            {...linkProps}
            ref={ref}
            data-progress-action={actionKey}
            onClick={(event) => {
                onClick?.(event);
                if (event.defaultPrevented) return;
                void recordAction(
                    analyticsContext,
                    actionKey,
                    recommendationKey
                );
            }}
        />
    );
});
