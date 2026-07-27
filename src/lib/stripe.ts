import Stripe from 'stripe';

let stripeClient: Stripe | null = null;

export function getStripeClient() {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
        throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    stripeClient ??= new Stripe(secretKey, {
        typescript: true,
    });
    return stripeClient;
}

export function appUrl() {
    return (
        process.env.BACKRANQ_APP_URL ??
        process.env.NEXTAUTH_URL ??
        process.env.VERCEL_PROJECT_PRODUCTION_URL ??
        'http://localhost:3000'
    ).replace(/\/$/, '');
}
