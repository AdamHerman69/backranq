type NetworkInformationLike = EventTarget & {
    effectiveType?: string;
    saveData?: boolean;
};

type NavigatorWithScheduling = Navigator & {
    connection?: NetworkInformationLike;
    scheduling?: { isInputPending?: () => boolean };
};

export type PostInteractiveTaskOptions = {
    minimumDelayMs?: number;
    requireFastConnection?: boolean;
};

export function canRunPassiveNetworkTask(): boolean {
    if (!navigator.onLine) return false;
    const connection = (navigator as NavigatorWithScheduling).connection;
    if (!connection) return true;
    if (connection.saveData) return false;
    return !['slow-2g', '2g'].includes(connection.effectiveType ?? '');
}

/**
 * Runs non-essential work only after load, two painted frames, and an idle
 * window. It deliberately has no eager idle timeout: passive work must not
 * compete with hydration or the user's first interaction.
 */
export function schedulePostInteractiveTask(
    task: () => void | Promise<void>,
    options: PostInteractiveTaskOptions = {}
): () => void {
    let cancelled = false;
    let delayHandle: number | null = null;
    let fallbackHandle: number | null = null;
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    let idleHandle: number | null = null;
    let waitingForConditions = false;
    const connection = (navigator as NavigatorWithScheduling).connection;

    const clearConditionListeners = () => {
        if (!waitingForConditions) return;
        waitingForConditions = false;
        window.removeEventListener('online', retry);
        document.removeEventListener('visibilitychange', retry);
        connection?.removeEventListener('change', retry);
    };

    const waitForConditions = () => {
        if (waitingForConditions) return;
        waitingForConditions = true;
        window.addEventListener('online', retry);
        document.addEventListener('visibilitychange', retry);
        connection?.addEventListener('change', retry);
    };

    const run = () => {
        idleHandle = null;
        fallbackHandle = null;
        if (cancelled) return;
        if (
            document.visibilityState !== 'visible' ||
            (options.requireFastConnection && !canRunPassiveNetworkTask())
        ) {
            waitForConditions();
            return;
        }
        const scheduling = (navigator as NavigatorWithScheduling).scheduling;
        if (scheduling?.isInputPending?.()) {
            fallbackHandle = window.setTimeout(run, 750);
            return;
        }
        clearConditionListeners();
        void task();
    };

    const queueIdle = () => {
        if (cancelled) return;
        firstFrame = window.requestAnimationFrame(() => {
            firstFrame = null;
            secondFrame = window.requestAnimationFrame(() => {
                secondFrame = null;
                if (typeof window.requestIdleCallback === 'function') {
                    idleHandle = window.requestIdleCallback(run);
                } else {
                    fallbackHandle = window.setTimeout(run, 1_500);
                }
            });
        });
    };

    function retry() {
        if (
            cancelled ||
            document.visibilityState !== 'visible' ||
            (options.requireFastConnection && !canRunPassiveNetworkTask())
        ) {
            return;
        }
        clearConditionListeners();
        queueIdle();
    }

    const afterLoad = () => {
        window.removeEventListener('load', afterLoad);
        if (cancelled) return;
        const delay = Math.max(0, options.minimumDelayMs ?? 0);
        if (delay > 0) {
            delayHandle = window.setTimeout(() => {
                delayHandle = null;
                queueIdle();
            }, delay);
        } else {
            queueIdle();
        }
    };

    if (document.readyState === 'complete') afterLoad();
    else window.addEventListener('load', afterLoad, { once: true });

    return () => {
        cancelled = true;
        window.removeEventListener('load', afterLoad);
        clearConditionListeners();
        if (delayHandle !== null) window.clearTimeout(delayHandle);
        if (fallbackHandle !== null) window.clearTimeout(fallbackHandle);
        if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
        if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
        if (idleHandle !== null) window.cancelIdleCallback(idleHandle);
    };
}
