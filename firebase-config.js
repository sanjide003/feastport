// firebase-config.js
// Centralized Firebase Configuration File

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getFirestore, connectFirestoreEmulator, enableIndexedDbPersistence, disableNetwork } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getStorage, connectStorageEmulator } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";
import { getFunctions, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js";
import { firebaseConfig as runtimeConfig } from "./firebase-runtime-config.js";
import { OperationType, handleFirestoreError, testFirestoreConnection } from "./data-cache.js";

const isFirebaseConfigured = Boolean(runtimeConfig?.apiKey && runtimeConfig?.projectId);

const firebaseConfig = isFirebaseConfigured
  ? runtimeConfig
  : {
      apiKey: "demo-unconfigured",
      authDomain: "localhost",
      projectId: "unconfigured-demo"
    };

const app = initializeApp(firebaseConfig);

const demo = firebaseConfig.projectId === 'demo-feastport' && ['localhost', '127.0.0.1'].includes(location.hostname);
export function portalAuth(instance) {
  const service = getAuth(instance);
  if (demo) connectAuthEmulator(service, 'http://127.0.0.1:9099', { disableWarnings: true });
  return service;
}
const auth = portalAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const functions = getFunctions(app);
if (demo) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
} else if (isFirebaseConfigured) {
  enableIndexedDbPersistence(db)
    .catch((err) => {
      if (err.code === 'failed-precondition') {
        console.log('Persistence failed: Multiple tabs open');
      } else if (err.code === 'unimplemented') {
        console.log('Persistence is not supported by this browser');
      }
    });
} else {
  console.warn('Firebase is not configured. Set FIREBASE_* variables in .env (see .env.example) to connect Firebase.');
  disableNetwork(db).catch(() => {});
}

export { app, auth, db, storage, functions, isFirebaseConfigured, OperationType, handleFirestoreError, testFirestoreConnection };
