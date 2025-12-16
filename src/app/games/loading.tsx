import styles from './page.module.css';

export default function Loading() {
    return (
        <div className={styles.page}>
            <main className={styles.main}>
                <header className={styles.header}>
                    <h1>Games</h1>
                    <p>Loading your games…</p>
                </header>
                <section className={styles.panel}>
                    <div className={styles.cards}>
                        {Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className={styles.skeleton} />
                        ))}
                    </div>
                </section>
            </main>
        </div>
    );
}


