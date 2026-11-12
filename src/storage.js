const DATABASE_NAME = "caustic-studio";
const DATABASE_VERSION = 1;
const STORE_NAME = "snapshots";
const SNAPSHOT_KEY = "latest";
const SNAPSHOT_VERSION = 1;

const openDatabase = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const withStore = async (mode, operation) => {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let request;
    try {
      request = operation(store);
    } catch (error) {
      database.close();
      reject(error);
      return;
    }
    request.onsuccess = () => {
      const result = request.result;
      transaction.oncomplete = () => {
        database.close();
        resolve(result);
      };
    };
    request.onerror = () => {
      database.close();
      reject(request.error);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error("IndexedDB transaction aborted"));
    };
  });
};

export const saveSnapshot = (snapshot) =>
  withStore("readwrite", (store) =>
    store.put(
      {
        ...snapshot,
        snapshotVersion: SNAPSHOT_VERSION,
        savedAt: Date.now(),
      },
      SNAPSHOT_KEY
    )
  );

export const loadSnapshot = async () => {
  const snapshot = await withStore("readonly", (store) => store.get(SNAPSHOT_KEY));
  if (!snapshot || snapshot.snapshotVersion !== SNAPSHOT_VERSION) return null;
  return snapshot;
};

export const clearSnapshot = () => withStore("readwrite", (store) => store.delete(SNAPSHOT_KEY));
