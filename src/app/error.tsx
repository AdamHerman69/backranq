'use client';

import { RotateCcw } from 'lucide-react';

import { ErrorState } from '@/components/ui/async-state';
import { Button } from '@/components/ui/button';

export default function Error({ reset }: { reset: () => void }) {
    return (
        <ErrorState
            className="mx-auto max-w-3xl"
            title="This view could not be prepared"
            description="Your games and practice history are safe. Try loading this view again."
            action={
                <Button type="button" onClick={reset}>
                    <RotateCcw aria-hidden="true" />
                    Try again
                </Button>
            }
        />
    );
}
