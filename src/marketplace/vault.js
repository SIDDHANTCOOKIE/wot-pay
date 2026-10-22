// Each record is encrypted before IndexedDB sees it. A revision compare-and-set
// rejects another tab overwriting keys or an in-flight mint operation.
export function createVault(signer, indexedDB = globalThis.indexedDB) {
  if (!signer?.sealLocal || !signer?.openLocal) throw new Error('Use a device identity for private marketplace storage.')
  let opened
  const db = () => opened ||= new Promise((resolve,reject) => {
    const request = indexedDB.open('wot-pay-private', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const key = id => `${signer.pubkey}:${id}`
  async function raw(id) {
    const database = await db()
    return new Promise((resolve,reject) => {
      const tx = database.transaction('records', 'readonly')
      const r = tx.objectStore('records').get(key(id))
      tx.oncomplete = () => resolve(r.result)
      tx.onerror = () => reject(tx.error)
    })
  }
  async function read(id) {
    const row = await raw(id)
    if (!row) return null
    const data = await signer.openLocal(row.sealed)
    if (data.owner !== signer.pubkey || data.id !== id || data.revision !== row.revision) throw new Error('Private record identity or revision mismatch.')
    return data
  }
  async function write(id, value, expectedRevision = 0, restoredRevision) {
    const revision=restoredRevision??expectedRevision+1
    if(!Number.isSafeInteger(revision)||revision<=expectedRevision)throw new Error('Invalid recovery revision.')
    const data = { owner: signer.pubkey, id, revision, value }
    const sealed = await signer.sealLocal(data)
    const database = await db()
    await new Promise((resolve,reject) => {
      const tx = database.transaction('records', 'readwrite'), store = tx.objectStore('records')
      let conflict = false
      const current = store.get(key(id))
      current.onsuccess = () => {
        if ((current.result?.revision || 0) !== expectedRevision) { conflict = true; tx.abort(); return }
        store.put({ key: key(id), owner: signer.pubkey, id, revision: data.revision, sealed })
      }
      tx.oncomplete = resolve
      tx.onabort = () => reject(new Error(conflict ? 'This trade changed in another tab. Reload before continuing.' : 'Private storage transaction aborted.'))
      tx.onerror = () => reject(tx.error)
    })
    return data
  }
  async function snapshot() {
    const database = await db()
    const rows = await new Promise((resolve,reject) => {
      const tx = database.transaction('records', 'readonly'), r = tx.objectStore('records').getAll()
      tx.oncomplete = () => resolve(r.result.filter(row => row.owner === signer.pubkey))
      tx.onerror = () => reject(tx.error)
    })
    return Promise.all(rows.map(row => read(row.id)))
  }
  return { read, write, snapshot }
}
