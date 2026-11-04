const DB_NAME = 'persona-canon-v1';
let database;

function openDatabase() {
    if (!database) database = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('contexts');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { database = null; reject(new Error('Не удалось открыть локальный журнал Persona Weaver.')); };
        request.onblocked = () => { database = null; reject(new Error('Закройте другие вкладки Persona Weaver и повторите.')); };
    });
    return database;
}

export async function loadState(identity) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const request = db.transaction('contexts').objectStore('contexts').get(identity);
        request.onsuccess = () => resolve(request.result ?? { version: 1, runs: [], history: [] });
        request.onerror = () => reject(new Error('Не удалось прочитать журнал.'));
    });
}

export async function saveState(identity, state) {
    // Never silently prune history or overwrite settings with full RP scenes.
    if (JSON.stringify(state).length > 10000000) throw new Error('Журнал превысил 10 млн символов. Сохранение остановлено; данные не удалены.');
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('contexts', 'readwrite');
        transaction.objectStore('contexts').put(structuredClone(state), identity);
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(new Error('Не удалось сохранить журнал. Проверьте свободное место в браузере.'));
    });
}
