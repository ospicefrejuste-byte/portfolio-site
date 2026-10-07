// Store only the state already filtered by the server for the signed-in user.
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('comptoir-local', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('cache');
    request.result.createObjectStore('commands', { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function operation(store, mode, callback) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = callback(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Stockage local indisponible'));
  });
}
export const local = {
  get: key => operation('cache', 'readonly', store => store.get(key)),
  set: (key, value) => operation('cache', 'readwrite', store => store.put(value, key)),
  remove: key => operation('cache', 'readwrite', store => store.delete(key)),
  enqueue: command => operation('commands', 'readwrite', store => store.put(command)),
  removeCommand: id => operation('commands', 'readwrite', store => store.delete(id)),
  async pending(userId) { return (await operation('commands', 'readonly', store => store.getAll())).filter(command => command.userId === userId).sort((a, b) => a.queuedAt - b.queuedAt); },
};
