const DATABASE_NAME = 'backranq-coach';
const DATABASE_VERSION = 1;
const STORE_NAME = 'coach-sessions';
const ACTIVE_SESSION_KEY = 'active';

/**
 * Small, dependency-free sign-out cleanup so the global navigation does not
 * pull chess.js and the full checkpoint sanitizer into every app page.
 */
export function clearCoachSessionOnSignOut(): Promise<void> {
    if (typeof window === 'undefined' || !window.indexedDB) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const request = window.indexedDB.open(
            DATABASE_NAME,
            DATABASE_VERSION
        );
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
        request.onsuccess = () => {
            const database = request.result;
            try {
                const transaction = database.transaction(
                    STORE_NAME,
                    'readwrite'
                );
                transaction.objectStore(STORE_NAME).delete(
                    ACTIVE_SESSION_KEY
                );
                transaction.oncomplete = () => {
                    database.close();
                    resolve();
                };
                transaction.onerror = () => {
                    database.close();
                    resolve();
                };
                transaction.onabort = () => {
                    database.close();
                    resolve();
                };
            } catch {
                database.close();
                resolve();
            }
        };
    });
}
