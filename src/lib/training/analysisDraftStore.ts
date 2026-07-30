import {
    sanitizeTrainingAnalysisTree,
    type TrainingAnalysisTree,
} from '@/lib/training/analysisTree';

const DATABASE_NAME = 'backranq-analysis';
const DATABASE_VERSION = 1;
const STORE_NAME = 'training-analysis-drafts';
const DRAFT_VERSION = 1;
const MAX_DRAFTS = 100;
const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

type TrainingAnalysisDraftRecord = {
    key: string;
    version: typeof DRAFT_VERSION;
    updatedAt: number;
    tree: TrainingAnalysisTree;
};

function draftKey(promptId: string, solutionRevisionId: string): string {
    return `${promptId}:${solutionRevisionId}`;
}

function openDatabase(): Promise<IDBDatabase | null> {
    if (typeof window === 'undefined' || !window.indexedDB) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        let settled = false;
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
        request.onsuccess = () => {
            if (settled) {
                request.result.close();
                return;
            }
            settled = true;
            resolve(request.result);
        };
        request.onerror = () => {
            settled = true;
            resolve(null);
        };
        request.onblocked = () => {
            if (!settled) {
                settled = true;
                resolve(null);
            }
        };
    });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T | null> {
    return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

async function removeExpiredAndExcessDrafts(
    database: IDBDatabase,
    now: number
): Promise<void> {
    const readTransaction = database.transaction(STORE_NAME, 'readonly');
    const records =
        (await requestResult(
            readTransaction
                .objectStore(STORE_NAME)
                .getAll() as IDBRequest<TrainingAnalysisDraftRecord[]>
        )) ?? [];
    const sorted = records
        .filter(
            (record) =>
                record &&
                typeof record.key === 'string' &&
                typeof record.updatedAt === 'number'
        )
        .sort((left, right) => right.updatedAt - left.updatedAt);
    const deleteKeys = sorted
        .filter(
            (record, index) =>
                now - record.updatedAt > MAX_DRAFT_AGE_MS ||
                index >= MAX_DRAFTS
        )
        .map((record) => record.key);
    if (deleteKeys.length === 0) return;

    const writeTransaction = database.transaction(STORE_NAME, 'readwrite');
    const store = writeTransaction.objectStore(STORE_NAME);
    for (const key of deleteKeys) store.delete(key);
    await transactionComplete(writeTransaction);
}

export async function loadTrainingAnalysisDraft(args: {
    promptId: string;
    solutionRevisionId: string;
    decisionFen: string;
}): Promise<TrainingAnalysisTree | null> {
    const database = await openDatabase();
    if (!database) return null;
    try {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const record = await requestResult(
            transaction
                .objectStore(STORE_NAME)
                .get(
                    draftKey(args.promptId, args.solutionRevisionId)
                ) as IDBRequest<TrainingAnalysisDraftRecord>
        );
        if (
            !record ||
            record.version !== DRAFT_VERSION ||
            Date.now() - record.updatedAt > MAX_DRAFT_AGE_MS
        ) {
            return null;
        }
        return sanitizeTrainingAnalysisTree(record.tree, args.decisionFen);
    } catch {
        return null;
    } finally {
        database.close();
    }
}

export async function saveTrainingAnalysisDraft(args: {
    promptId: string;
    solutionRevisionId: string;
    tree: TrainingAnalysisTree;
}): Promise<boolean> {
    const database = await openDatabase();
    if (!database) return false;
    try {
        const now = Date.now();
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put({
            key: draftKey(args.promptId, args.solutionRevisionId),
            version: DRAFT_VERSION,
            updatedAt: now,
            tree: args.tree,
        } satisfies TrainingAnalysisDraftRecord);
        await transactionComplete(transaction);
        await removeExpiredAndExcessDrafts(database, now);
        return true;
    } catch {
        return false;
    } finally {
        database.close();
    }
}
