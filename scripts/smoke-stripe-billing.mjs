#!/usr/bin/env node
import Stripe from 'stripe';
import { loadEnvFiles } from './lib/load-env.mjs';

loadEnvFiles();

const secretKey = process.env.STRIPE_SECRET_KEY;
const prices = [
    ['PLUS', process.env.STRIPE_PRICE_PLUS_MONTHLY],
    ['PRO', process.env.STRIPE_PRICE_PRO_MONTHLY],
];

if (!secretKey) {
    console.error('STRIPE_SECRET_KEY is not configured.');
    process.exit(1);
}

if (!secretKey.startsWith('sk_test_')) {
    console.error('Refusing Stripe smoke against a non-test secret key.');
    process.exit(1);
}

const stripe = new Stripe(secretKey, { typescript: true });
const failures = [];

for (const [plan, priceId] of prices) {
    if (!priceId) {
        failures.push(`${plan}: missing price id`);
        continue;
    }
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    const recurring = price.recurring;
    console.log(
        `${plan}: ${price.id} ${price.unit_amount ?? 'unknown'} ${price.currency} ${recurring?.interval ?? 'one_time'} livemode=${price.livemode}`
    );
    if (price.livemode) failures.push(`${plan}: price is live-mode, expected test-mode`);
    if (!price.active) failures.push(`${plan}: price is inactive`);
    if (recurring?.interval !== 'month') {
        failures.push(`${plan}: expected monthly recurring price`);
    }
}

if (failures.length > 0) {
    console.error(`\nStripe smoke failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
}

console.log('\nStripe test-mode price smoke passed.');
