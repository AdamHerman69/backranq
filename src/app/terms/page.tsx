import type { Metadata } from 'next';
import Link from 'next/link';

import {
    DocumentSection,
    PublicDocumentShell,
} from '@/app/_components/PublicDocumentShell';

export const metadata: Metadata = {
    title: 'Terms of Service — Backranq',
    description: 'The terms that apply when you use Backranq.',
};

export default function TermsPage() {
    return (
        <PublicDocumentShell
            eyebrow="Trust center"
            title="Terms of Service"
            introduction="These terms set the ground rules for using Backranq. They are designed to keep the service useful, fair and safe for everyone."
            updatedAt="August 7, 2026"
        >
            <DocumentSection id="agreement" title="1. Your agreement">
                <p>
                    By creating an account, purchasing a plan or using Backranq, you agree to these Terms and the <Link href="/privacy">Privacy Policy</Link>. If you do not agree, do not use the service.
                </p>
            </DocumentSection>

            <DocumentSection id="eligibility" title="2. Eligibility and accounts">
                <p>
                    You must be legally able to enter this agreement and meet the minimum age required where you live. Keep your sign-in method secure, provide accurate information and tell us promptly if you believe your account has been compromised. You are responsible for activity performed through your account.
                </p>
            </DocumentSection>

            <DocumentSection id="service" title="3. The Backranq service">
                <p>
                    Backranq imports eligible chess games, analyzes positions and provides Practice, Coach and Progress experiences. Some analysis runs in your browser; other analysis may run on managed infrastructure and use plan credits or limits.
                </p>
                <p>
                    Chess evaluations are computational estimates. Training positions, classifications, engine lines, accuracy and coaching feedback may be incomplete or wrong and are provided for learning, not as professional advice or a guarantee of chess improvement.
                </p>
            </DocumentSection>

            <DocumentSection id="sources" title="4. Your games and connected services">
                <p>
                    You may connect only accounts and submit only game data you are authorized to use. Public game data remains subject to the source provider&apos;s terms. Lichess, Chess.com, identity providers and other integrations are independent services; Backranq does not control their availability or policies.
                </p>
                <p>
                    You retain rights you already hold in content you submit. You grant Backranq the limited permission needed to host, process, analyze and display that content to operate the service.
                </p>
            </DocumentSection>

            <DocumentSection id="acceptable-use" title="5. Acceptable use">
                <p>You may not:</p>
                <ul>
                    <li>break the law, infringe another person&apos;s rights or impersonate someone else;</li>
                    <li>access another person&apos;s account or private data without permission;</li>
                    <li>interfere with, overload, probe or reverse engineer the service except where law expressly permits it;</li>
                    <li>automate access in a way that bypasses limits or harms Backranq or a connected chess provider;</li>
                    <li>use Backranq&apos;s engine assistance to violate fair-play rules during a live competitive game.</li>
                </ul>
            </DocumentSection>

            <DocumentSection id="plans" title="6. Plans, credits and payment">
                <p>
                    Paid features, prices, billing periods, included credits and plan limits are shown before purchase. Payments are processed by Stripe. Subscriptions renew until cancelled. You can manage an eligible subscription in Settings. Cancellation stops future renewal and access normally continues through the paid period unless stated otherwise.
                </p>
                <p>
                    Fees are non-refundable except where required by law or expressly stated at purchase. Complimentary or promotional access can have separate conditions and may be revoked if obtained or used abusively.
                </p>
            </DocumentSection>

            <DocumentSection id="availability" title="7. Availability and changes">
                <p>
                    We work to keep Backranq available, but do not guarantee uninterrupted service or perpetual support for a feature, provider or model. We may change, suspend or discontinue functionality, apply reasonable usage limits, or perform maintenance. When a material change affects a paid service, we will provide notice where reasonably possible or required by law.
                </p>
            </DocumentSection>

            <DocumentSection id="intellectual-property" title="8. Backranq intellectual property">
                <p>
                    Backranq and its original interface, software, branding and content are protected by intellectual-property laws. These Terms give you a personal, limited, non-exclusive, non-transferable right to use the service; they do not transfer ownership.
                </p>
            </DocumentSection>

            <DocumentSection id="termination" title="9. Suspension and termination">
                <p>
                    You may stop using Backranq at any time. We may restrict or terminate access when reasonably necessary to address a Terms violation, security risk, legal requirement, non-payment or harm to the service or others. Where appropriate, we will provide notice and an opportunity to remedy the issue.
                </p>
            </DocumentSection>

            <DocumentSection id="disclaimers" title="10. Disclaimers and liability">
                <p>
                    To the extent permitted by law, Backranq is provided “as is” and “as available” without implied warranties. We are not responsible for losses caused by connected third-party services, inaccurate chess analysis, unavailable public data or uses contrary to provider fair-play rules.
                </p>
                <p>
                    To the extent permitted by law, Backranq will not be liable for indirect, incidental, special, consequential or punitive damages, or loss of data, profits or goodwill. Nothing in these Terms limits liability or consumer rights that cannot legally be limited.
                </p>
            </DocumentSection>

            <DocumentSection id="law" title="11. Applicable law and disputes">
                <p>
                    Applicable law and mandatory consumer protections continue to apply. Before starting a formal dispute, please contact us so we can try to resolve the issue informally. These Terms do not remove any right to use a regulator, court or dispute process available to you under mandatory law.
                </p>
            </DocumentSection>

            <DocumentSection id="changes-contact" title="12. Changes and contact">
                <p>
                    We may update these Terms. Material changes will be communicated before they take effect where required. Continued use after the effective date means the updated Terms apply. Questions can be sent to <a href="mailto:support@backranq.com">support@backranq.com</a> or through <Link href="/support">Support</Link>.
                </p>
            </DocumentSection>
        </PublicDocumentShell>
    );
}
