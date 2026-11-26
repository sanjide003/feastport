# Run the local festival

Use Node.js 20 for Firebase Functions, Java 21 for the emulators and Bun for the web dependencies. From the repository root, run:

```sh
bun install --frozen-lockfile
npm ci --prefix functions
npx firebase-tools@14.27.0 emulators:start --project demo-feastport --only auth,firestore,functions,storage
```

Once all four emulators are ready, use a second terminal in the same directory:

```sh
npm run seed:demo
npm run demo
```

Open the local server on port 3000. The seed prints a temporary password for the three fictional staff accounts. Re-running the seed refreshes those accounts and their sample records. To supply a local password yourself, set `FEASTPORT_DEMO_PASSWORD` before seeding.

1. Open **Register**, choose **Aurora** and **Girls**, search for **River Lane**, and verify with chest number **A101**.
2. Open **Events**, apply for **Spoken Word**, and check the application status.
3. Sign in as **teamleader@example.test**. Open **Requests** and approve the entry.
4. Sign in as **judge@example.test**. Score the assigned event and submit the sheet.
5. Sign in as **admin@example.test**. Open **Judging & Results → Judge Sheets** and publish the submitted sheet.
6. Open public **Results** and select **Aurora**. **Solo Rhythm** is pre-published so the filter also works before the judging exercise.

Each demo server binds to loopback and selects the fixed emulator project. The ordinary `npm run dev` command uses the configured Firebase project. Rebuild the static Tailwind stylesheet with `npm run styles` after changing utility classes. Run `npm run check` and `node scripts/http-check.mjs` before committing.
