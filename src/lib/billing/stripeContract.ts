const TERMINAL_STRIPE_SUBSCRIPTION_STATUSES = new Set([
    'canceled',
    'incomplete_expired',
]);

const STRIPE_ACCESS_STATUSES = new Set(['active', 'trialing']);

/**
 * A non-terminal Stripe subscription is still a commercial contract. It must
 * be managed through the billing portal instead of creating a second checkout,
 * even when it does not currently provide product access.
 */
export function hasLiveStripeContract(status: string | null): boolean {
    return status !== null && !TERMINAL_STRIPE_SUBSCRIPTION_STATUSES.has(status);
}

/** Only active and trialing subscriptions contribute a paid entitlement. */
export function stripeSubscriptionProvidesAccess(
    status: string | null
): boolean {
    return status !== null && STRIPE_ACCESS_STATUSES.has(status);
}
