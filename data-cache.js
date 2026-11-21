// data-cache.js
// Shared TTL cache + Firestore error & connection helpers for Blaze Read Optimization

import { doc, getDoc, getDocFromServer, getDocs } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

export const OperationType = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write'
});

const CACHE_PREFIX = 'fp_cache_v2:';
const memoryCache = new Map();
const inflightRequests = new Map();

export function handleFirestoreError(error, operationType, path, auth = null) {
  const user = auth?.currentUser;
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    code: error?.code || '',
    operationType,
    path,
    authInfo: {
      userId: user?.uid || null,
      email: user?.email || null
    }
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  return errInfo;
}

export async function testFirestoreConnection(db) {
  try {
    await getDocFromServer(doc(db, 'settings', 'home_config'));
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('the client is offline')) {
      console.warn('Firestore appears offline or unreachable.');
    }
    return { ok: false, error: message };
  }
}

function readSessionEntry(key) {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.expiresAt !== 'number') return null;
    if (Date.now() > parsed.expiresAt) {
      sessionStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSessionEntry(key, data, expiresAt) {
  try {
    const serialized = JSON.stringify({ data, expiresAt });
    // Avoid bloating sessionStorage with massive payloads (> 512 KB)
    if (serialized.length <= 512 * 1024) {
      sessionStorage.setItem(CACHE_PREFIX + key, serialized);
    }
  } catch {
    // Ignore storage quota errors cleanly
  }
}

export function getCachedValue(key) {
  const now = Date.now();
  const mem = memoryCache.get(key);
  if (mem && mem.expiresAt > now) return mem.data;
  if (mem) memoryCache.delete(key);

  const sess = readSessionEntry(key);
  if (sess) {
    memoryCache.set(key, sess);
    return sess.data;
  }
  return undefined;
}

export function setCachedValue(key, data, ttlMs = 180_000, persistSession = true) {
  const expiresAt = Date.now() + Math.max(0, ttlMs);
  const entry = { data, expiresAt };
  memoryCache.set(key, entry);
  if (persistSession) writeSessionEntry(key, data, expiresAt);
  return data;
}

export function invalidateCache(prefix = '') {
  for (const key of [...memoryCache.keys()]) {
    if (!prefix || key.startsWith(prefix)) memoryCache.delete(key);
  }
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const storageKey = sessionStorage.key(i);
      if (!storageKey || !storageKey.startsWith(CACHE_PREFIX)) continue;
      const logicalKey = storageKey.slice(CACHE_PREFIX.length);
      if (!prefix || logicalKey.startsWith(prefix)) {
        sessionStorage.removeItem(storageKey);
      }
    }
  } catch {
    // Ignore
  }
}

export async function cachedGetDoc(db, collectionName, docId, { ttlMs = 300_000, forceRefresh = false, persistSession = true } = {}) {
  const cacheKey = `doc:${collectionName}/${docId}`;
  if (!forceRefresh) {
    const hit = getCachedValue(cacheKey);
    if (hit !== undefined) return hit;
  }
  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }
  const promise = getDoc(doc(db, collectionName, docId))
    .then((snap) => {
      const data = snap.exists() ? { id: snap.id, ...snap.data(), _exists: true } : null;
      return setCachedValue(cacheKey, data, ttlMs, persistSession);
    })
    .finally(() => inflightRequests.delete(cacheKey));

  inflightRequests.set(cacheKey, promise);
  return promise;
}

export async function cachedGetDocs(cacheKey, firestoreQuery, { ttlMs = 120_000, forceRefresh = false, persistSession = true } = {}) {
  if (!forceRefresh) {
    const hit = getCachedValue(cacheKey);
    if (hit !== undefined) return hit;
  }
  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }
  const promise = getDocs(firestoreQuery)
    .then((snap) => {
      const rows = snap.docs.map((item) => ({ id: item.id, ...item.data() }));
      return setCachedValue(cacheKey, rows, ttlMs, persistSession);
    })
    .finally(() => inflightRequests.delete(cacheKey));

  inflightRequests.set(cacheKey, promise);
  return promise;
}
