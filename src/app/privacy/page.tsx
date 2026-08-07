import type { Metadata } from 'next';
import Link from 'next/link';

import {
    DocumentSection,
    PublicDocumentShell,
} from '@/app/_components/PublicDocumentShell';

export const metadata: Metadata = {
    title: 'Privacy Policy — Backranq',
    description: 'How Backranq collects, uses and protects personal information.',
};

export default function PrivacyPage() {
    return (
        <PublicDocumentShell
            eyebrow="Trust center"
            title="Privacy Policy"
            introduction="Backranq turns chess games into personal practice. This policy explains which information supports that experience, why we use it and the choices available to you."
            updatedAt="August 7, 2026"
        >
            <DocumentSection id="scope" title="1. Scope">
                <p>
                    This policy applies to the Backranq website, web application and related messages. It does not govern the independent services you connect, such as Lichess, Chess.com, an identity provider or Stripe.
                </p>
            </DocumentSection>

            <DocumentSection id="information" title="2. Information we handle">
                <ul>
                    <li><strong>Account information.</strong> Your name, email address, profile image and provider account identifier when you sign in.</li>
                    <li><strong>Chess information.</strong> Public chess usernames, imported games, PGN data, ratings, analysis, training positions and the attempts you make in Practice.</li>
                    <li><strong>Preferences and progress.</strong> Linked-account settings, sync and analysis choices, notification preferences and learning history.</li>
                    <li><strong>Plan and billing information.</strong> Your plan, credit balance and subscription status. Payment card details are handled by Stripe and are not stored by Backranq.</li>
                    <li><strong>Device and service data.</strong> Basic logs, error information, security events and product events needed to operate and improve the service. Offline Coach games and downloaded model assets may remain on your device until you remove them.</li>
                </ul>
                <p>
                    The landing-page username search uses public games to prepare a position. The username is not included in onboarding analytics.
                </p>
            </DocumentSection>

            <DocumentSection id="use" title="3. Why we use information">
                <p>We use information to:</p>
                <ul>
                    <li>provide sign-in, game import, analysis, Practice, Coach and Progress;</li>
                    <li>save your settings, training history and subscription entitlements;</li>
                    <li>send service, training or product notifications you have enabled;</li>
                    <li>protect accounts, prevent abuse and diagnose failures;</li>
                    <li>understand aggregated product performance and improve Backranq.</li>
                </ul>
                <p>
                    Depending on where you live, these activities rely on performing our agreement with you, legitimate interests in operating a safe and useful service, your consent, or legal obligations.
                </p>
            </DocumentSection>

            <DocumentSection id="sharing" title="4. When information is shared">
                <p>
                    We do not sell personal information. We share only what is needed with service providers that help operate Backranq, including hosting and database providers, sign-in providers, Stripe for billing, and email or push-delivery providers. They process information under their own terms and applicable data-protection obligations.
                </p>
                <p>
                    We may also disclose information when required by law, to protect users or the service, or as part of a business reorganization subject to appropriate safeguards.
                </p>
            </DocumentSection>

            <DocumentSection id="public-sources" title="5. Public chess sources">
                <p>
                    When you connect or search for a public Lichess or Chess.com username, Backranq requests public profile and game data from that provider. Removing a linked account stops future sync; games already imported remain in your library until you delete them.
                </p>
            </DocumentSection>

            <DocumentSection id="retention" title="6. Retention and deletion">
                <p>
                    We keep account and training information while your account is active and as reasonably needed to provide the service, meet legal obligations, resolve disputes and protect the service. Retention can vary by record type. You can remove individual games in Backranq and request account-data deletion through <Link href="/support">Support</Link>.
                </p>
            </DocumentSection>

            <DocumentSection id="choices" title="7. Your choices and rights">
                <ul>
                    <li>Change connected chess accounts and Practice, analysis or notification preferences in Settings.</li>
                    <li>Disable browser push notifications through Backranq or your browser.</li>
                    <li>Ask to access, correct, export or delete personal information, subject to applicable exceptions.</li>
                    <li>Withdraw consent where processing is based on consent.</li>
                    <li>Object to or ask us to restrict certain processing where local law provides that right.</li>
                </ul>
                <p>Contact us through <Link href="/support">Support</Link> to make a privacy request. We may need to verify your account before completing it.</p>
            </DocumentSection>

            <DocumentSection id="security" title="8. Security and international processing">
                <p>
                    We use technical and organizational safeguards intended to protect information. No online service can promise absolute security. Providers may process data in countries other than your own; where required, appropriate transfer safeguards apply.
                </p>
            </DocumentSection>

            <DocumentSection id="children" title="9. Children">
                <p>
                    Backranq is not directed to children under 13. Do not create an account if you are below the minimum age required in your country without the authorization required by local law.
                </p>
            </DocumentSection>

            <DocumentSection id="changes-contact" title="10. Changes and contact">
                <p>
                    We may update this policy as Backranq evolves. Material changes will be communicated in the service or by another appropriate channel. Questions can be sent to <a href="mailto:support@backranq.com">support@backranq.com</a>.
                </p>
            </DocumentSection>
        </PublicDocumentShell>
    );
}
