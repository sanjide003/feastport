// firebase-config.js
// Centralized Firebase Configuration File

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getFirestore, enableIndexedDbPersistence, disableNetwork } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";
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

const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

if (isFirebaseConfigured) {
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

export { app, auth, db, storage, isFirebaseConfigured, OperationType, handleFirestoreError, testFirestoreConnection };
