import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootDir = resolve('.');

const envPath = join(rootDir, '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

async function loadStaticRuntimeConfig() {
  const staticPath = join(rootDir, 'firebase-runtime-config.js');
  if (!existsSync(staticPath)) return {};
  try {
    const mod = await import(`./firebase-runtime-config.js?t=${Date.now()}`);
    return mod?.firebaseConfig || {};
  } catch {
    return {};
  }
}

async function loadFirebaseConfig() {
  const appletConfigPath = join(rootDir, 'firebase-applet-config.json');
  let appletConfig = {};
  if (existsSync(appletConfigPath)) {
    try {
      appletConfig = JSON.parse(readFileSync(appletConfigPath, 'utf8'));
    } catch {
      appletConfig = {};
    }
  }
  const staticConfig = await loadStaticRuntimeConfig();
  const baseConfig = appletConfig.apiKey ? appletConfig : staticConfig;

  return {
    apiKey: process.env.FIREBASE_API_KEY || baseConfig.apiKey || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || baseConfig.authDomain || '',
    projectId: process.env.FIREBASE_PROJECT_ID || baseConfig.projectId || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || baseConfig.storageBucket || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || baseConfig.messagingSenderId || '',
    appId: process.env.FIREBASE_APP_ID || baseConfig.appId || '',
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || baseConfig.measurementId || ''
  };
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

const blockedPrefixes = ['/functions', '/scripts', '/node_modules', '/.git'];
const blockedFiles = new Set([
  '/.env',
  '/.env.example',
  '/.firebaserc',
  '/.vercelignore',
  '/server.js',
  '/package.json',
  '/package-lock.json',
  '/firebase-applet-config.json',
  '/firebase.json',
  '/firestore.rules',
  '/storage.rules',
  '/vercel.json',
  '/metadata.json'
]);

app.use((req, res, next) => {
  const reqPath = req.path.toLowerCase();
  if (
    reqPath.startsWith('/.env') ||
    blockedFiles.has(reqPath) ||
    blockedPrefixes.some((prefix) => reqPath === prefix || reqPath.startsWith(prefix + '/'))
  ) {
    return res.status(404).send('Not Found');
  }
  next();
});

app.get('/firebase-runtime-config.js', async (req, res) => {
  const config = await loadFirebaseConfig();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`export const firebaseConfig = ${JSON.stringify(config)};\n`);
});

app.use(express.static(rootDir, { extensions: ['html'] }));

app.listen(PORT, HOST, () => {
  console.log(`Fest Portal server running at http://${HOST}:${PORT}`);
});
