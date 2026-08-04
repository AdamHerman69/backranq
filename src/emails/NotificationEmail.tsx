import {
    Body,
    Button,
    Container,
    Head,
    Heading,
    Hr,
    Html,
    Link,
    Preview,
    Section,
    Text,
} from 'react-email';

export type NotificationEmailProps = {
    preview: string;
    heading: string;
    body: string;
    actionLabel: string;
    actionUrl: string;
    settingsUrl: string;
    unsubscribeUrl?: string;
};

export default function NotificationEmail({
    preview,
    heading,
    body,
    actionLabel,
    actionUrl,
    settingsUrl,
    unsubscribeUrl,
}: NotificationEmailProps) {
    return (
        <Html>
            <Head />
            <Preview>{preview}</Preview>
            <Body style={styles.body}>
                <Container style={styles.container}>
                    <Text style={styles.brand}>BACKRANQ</Text>
                    <Heading style={styles.heading}>{heading}</Heading>
                    <Text style={styles.text}>{body}</Text>
                    <Section style={styles.action}>
                        <Button href={actionUrl} style={styles.button}>
                            {actionLabel}
                        </Button>
                    </Section>
                    <Hr style={styles.hr} />
                    <Text style={styles.footer}>
                        You can change notification preferences in{' '}
                        <Link href={settingsUrl}>Backranq settings</Link>.
                        {unsubscribeUrl ? (
                            <>
                                {' '}
                                <Link href={unsubscribeUrl}>
                                    Unsubscribe from optional emails
                                </Link>
                                .
                            </>
                        ) : null}
                    </Text>
                </Container>
            </Body>
        </Html>
    );
}

const styles = {
    body: {
        backgroundColor: '#f4f4f5',
        color: '#18181b',
        fontFamily: 'Arial, Helvetica, sans-serif',
        margin: 0,
        padding: '32px 12px',
    },
    container: {
        backgroundColor: '#ffffff',
        border: '1px solid #e4e4e7',
        borderRadius: '12px',
        margin: '0 auto',
        maxWidth: '560px',
        padding: '32px',
    },
    brand: {
        color: '#71717a',
        fontSize: '12px',
        fontWeight: '700',
        letterSpacing: '0.14em',
        margin: '0 0 20px',
    },
    heading: { fontSize: '26px', lineHeight: '1.25', margin: '0 0 16px' },
    text: { fontSize: '16px', lineHeight: '1.6', margin: '0 0 24px' },
    action: { margin: '24px 0' },
    button: {
        backgroundColor: '#18181b',
        borderRadius: '8px',
        color: '#ffffff',
        display: 'inline-block',
        fontSize: '15px',
        fontWeight: '600',
        padding: '12px 20px',
        textDecoration: 'none',
    },
    hr: { borderColor: '#e4e4e7', margin: '28px 0 20px' },
    footer: { color: '#71717a', fontSize: '12px', lineHeight: '1.5' },
} as const;
