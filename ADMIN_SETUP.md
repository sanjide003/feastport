# Firebase (`test-feasta`), Admin Login, Vercel Hosting & Complete Firestore Schema Guide

ഈ ഗൈഡ് നിങ്ങളുടെ `test-feasta` ഫയർബേസ് പ്രൊജക്റ്റിലേക്ക് ഈ ആർട്സ് ഫെസ്റ്റ് ആപ്ലിക്കേഷൻ കണക്ട് ചെയ്യാനും, GitHub വഴി Vercel-ൽ പബ്ലിഷ് ചെയ്യാനും, **ആദ്യമായി Admin ലോഗിൻ ചെയ്യാനും**, Firestore-ൽ ഉപയോഗിക്കുന്ന എല്ലാ Collection, Document, Field പേരുകളും അവയുടെ കൃത്യമായ Data Type-ഉം മനസ്സിലാക്കാനും വേണ്ടിയുള്ളതാണ്.

> **പ്രധാന കുറിപ്പ്:** Firestore Console-ൽ മാനുവലായി ഫീൽഡുകൾ ചേർക്കുമ്പോൾ താഴെ നൽകിയിരിക്കുന്ന കൃത്യമായ **English field names**-ഉം **Firestore Data Types** (`string`, `boolean`, `number`, `array`, `map`)-ഉം തന്നെ നൽകണം.

---

## 1. Firebase Console-ൽ ചെയ്യേണ്ട പ്രാരംഭ ക്രമീകരണങ്ങൾ (`test-feasta`)

### ഘട്ടം 1: Authentication സജ്ജീകരിക്കുക
1. [Firebase Console](https://console.firebase.google.com/) തുറന്ന് **`test-feasta`** പ്രൊജക്റ്റ് തിരഞ്ഞെടുക്കുക.
2. ഇടതുവശത്തുള്ള മെനുവിൽ **Build → Authentication → Get started** ക്ലിക്ക് ചെയ്യുക.
3. **Sign-in method** ടാബിൽ പോയി:
   - **Email/Password** തിരഞ്ഞെടുത്ത് **Enable** ചെയ്ത് Save ചെയ്യുക *(നിർബന്ധം)*.
   - *(ഐച്ഛികം)* Live TV പേജിനായി വേണമെങ്കിൽ **Anonymous** കൂടി Enable ചെയ്യാം.
4. **Authentication → Settings → Authorized domains** തുറക്കുക:
   - **Add domain** ക്ലിക്ക് ചെയ്ത് നിങ്ങളുടെ Vercel പ്രൊഡക്ഷൻ ഡൊമെയ്ൻ (ഉദാ: `your-project.vercel.app` അല്ലെങ്കിൽ നിങ്ങളുടെ custom domain) ചേർക്കുക.

### ഘട്ടം 2: Cloud Firestore & Security Rules Deploy ചെയ്യുക
1. **Build → Firestore Database → Create database** ക്ലിക്ക് ചെയ്യുക.
2. നിങ്ങൾക്ക് സൗകര്യപ്രദമായ ഒരു Region തിരഞ്ഞെടുത്ത് **Start in production mode** നൽകി Create ചെയ്യുക.
3. പ്രൊജക്റ്റിലുള്ള **`firestore.rules`** ഫയലിലെ മുഴുവൻ കോഡും കോപ്പി ചെയ്ത് Firebase Console-ലെ **Firestore Database → Rules** ടാബിൽ പേസ്റ്റ് ചെയ്ത് **Publish** ക്ലിക്ക് ചെയ്യുക.
4. *(Firebase CLI ഉപയോഗിക്കുന്നുവെങ്കിൽ)* പ്രൊജക്റ്റിൽ `.firebaserc` ഫയൽ `test-feasta` ആയി സെറ്റ് ചെയ്തിട്ടുള്ളതിനാൽ താഴെ കാണുന്ന കമാൻഡ് വഴിയും Rules പബ്ലിഷ് ചെയ്യാം:
   ```bash
   firebase deploy --only firestore:rules,storage
   ```

---

## 2. ആദ്യത്തെ Admin ലോഗിൻ (First Admin Account Setup)

ആദ്യമായി ആരും Admin അല്ലാത്തതിനാൽ, **ആദ്യത്തെ Admin അക്കൗണ്ട് മാത്രം Firebase Console വഴി നേരിട്ട് നിർമ്മിക്കണം**. അതിന് ശേഷം പുതിയ Team Leaders, Judges, മറ്റ് Admins എന്നിവരെല്ലാം Admin Panel വഴി തന്നെ ഉണ്ടാക്കാം.

### ഘട്ടം 1: Firebase Auth-ൽ Admin യൂസറെ സൃഷ്ടിക്കുക
1. **Authentication → Users → Add user** ക്ലിക്ക് ചെയ്യുക.
2. Admin ഇമെയിൽ (ഉദാ: `admin@feasta.com`), പാസ്‌വേഡ് എന്നിവ നൽകി **Add user** അമർത്തുക.
3. അവിടെ സൃഷ്ടിക്കപ്പെട്ട യൂസറുടെ **User UID** കോപ്പി ചെയ്യുക (ഉദാ: `xYz123AbC456...`).

### ഘട്ടം 2: Firestore-ൽ `adminUsers` ഡോക്യുമെന്റ് നിർമ്മിക്കുക *(നിർബന്ധം)*
1. **Firestore Database → Data → Start collection** ക്ലിക്ക് ചെയ്യുക.
2. **Collection ID**: `adminUsers`
3. **Document ID**: മുകളിൽ കോപ്പി ചെയ്ത **User UID** അതേപടി പേസ്റ്റ് ചെയ്യുക *(Auto-ID ഉപയോഗിക്കരുത്!)*.
4. താഴെ കൊടുത്തിരിക്കുന്ന കൃത്യമായ ഫീൽഡുകളും Type-ഉം നൽകുക:

| Field Name | Firestore Type | Example Value | വിവരണം |
| --- | --- | --- | --- |
| `email` | `string` | `"admin@feasta.com"` | Authentication-ൽ നൽകിയ അതേ ഇമെയിൽ |
| `username` | `string` | `"admin"` | ചെറിയക്ഷരത്തിലുള്ള (lowercase) യൂസർനെയിം |
| `displayName` | `string` | `"Fest Admin"` | Admin Panel-ൽ കാണിക്കേണ്ട പേര് |
| `role` | `string` | `"superAdmin"` | `"superAdmin"` അല്ലെങ്കിൽ `"admin"` |
| `active` | `boolean` | `true` | `true` ആയാൽ മാത്രമേ ലോഗിൻ അനുവദിക്കൂ |
| `createdAt` | `number` | `1732180000000` | നിലവിലെ Epoch milliseconds (`number` ടൈപ്പ്, `timestamp` അല്ല) |

### ഘട്ടം 3: Username വഴിയുള്ള ലോഗിൻ *(ഐച്ഛികം)*
Email ടൈപ്പ് ചെയ്യാതെ `"admin"` എന്ന ചെറിയ username വഴിയും `login.html`-ൽ ലോഗിൻ ചെയ്യണമെങ്കിൽ ഈ ഡോക്യുമെന്റ് കൂടി ഉണ്ടാക്കുക:
- **Collection ID**: `adminUsernames`
- **Document ID**: `admin` *(lowercase username)*

| Field Name | Firestore Type | Example Value | വിവരണം |
| --- | --- | --- | --- |
| `email` | `string` | `"admin@feasta.com"` | മുകളിൽ നൽകിയ Admin ഇമെയിൽ |
| `uid` | `string` | `"xYz123AbC456..."` | Admin User UID |
| `active` | `boolean` | `true` | സജീവമാണോ എന്ന് (`true`) |

### ഘട്ടം 4: ആദ്യമായി Login ചെയ്യുക
1. നിങ്ങളുടെ സൈറ്റിൽ `/login` (അല്ലെങ്കിൽ `login.html`) തുറക്കുക.
2. Email (`admin@feasta.com`) അല്ലെങ്കിൽ Username (`admin`) + Password നൽകി **Sign In** ക്ലിക്ക് ചെയ്യുക.
3. ലോഗിൻ വിജയകരമായാൽ സിസ്റ്റം സ്വയം **`/admin`** (Admin Console) പേജിലേക്ക് കടക്കും.
4. ആദ്യം തന്നെ Admin Panel → **Fest Setup** ടാബിൽ പോയി Fest പേര്, Teams, Categories, Stages, Days എന്നിവ Save ചെയ്യുക.

---

## 3. GitHub വഴി Vercel-ൽ പബ്ലിഷ് ചെയ്യുന്ന വിധം

ഈ ആപ്ലിക്കേഷൻ Vercel-ൽ സ്റ്റാറ്റിക് വെബ്സൈറ്റായി നേരിട്ട് പ്രവർത്തിക്കുന്ന രീതിയിലാണ് സജ്ജീകരിച്ചിരിക്കുന്നത്:
1. നിങ്ങളുടെ പ്രൊജക്റ്റ് GitHub repository-യിലേക്ക് **Push** ചെയ്യുക (`firebase-runtime-config.js`-ൽ `test-feasta` വിവരങ്ങൾ ഇതിനകം ഉൾപ്പെടുത്തിയിട്ടുണ്ട്).
2. [Vercel Dashboard](https://vercel.com/) തുറന്ന് **Add New… → Project** ക്ലിക്ക് ചെയ്ത് GitHub repo Select ചെയ്യുക.
3. Build settings (സാധാരണ `vercel.json` സ്വയം എടുക്കും):
   - **Framework Preset**: `Other`
   - **Build Command**: *(ശൂന്യം / Override വേണ്ട)*
   - **Output Directory**: `.` *(Root)*
4. **Deploy** ക്ലിക്ക് ചെയ്യുക.
5. Deploy പൂർത്തിയായി ലഭിക്കുന്ന ഡൊമെയ്ൻ (ഉദാ: `https://feasta-fest.vercel.app`) Firebase Console → **Authentication → Settings → Authorized domains**-ൽ ചേർക്കുക.

> പ്രധാന URL-കൾ (Clean URLs Vercel-ൽ സജീവമാണ്): `/`, `/register`, `/results`, `/login`, `/admin`, `/team`, `/judge`, `/tv`, `/tv-control`

---

## 4. സമ്പൂർണ്ണ Firestore Database Schema (Collections, Documents, Fields & Types)

> **പ്രധാന നിയമം:** കോഡിൽ സമയം (time/date stamp) സേവ് ചെയ്യുന്നത് `Date.now()` ഉപയോഗിച്ചാണ്. അതിനാൽ എല്ലാ `*At` ഫീൽഡുകളും Firestore-ൽ **`number`** (Epoch milliseconds) ടൈപ്പിലാണ് വരേണ്ടത്, native Firestore `timestamp` അല്ല.

### A. Authentication & Role Access Collections

#### 1. `adminUsers/{uid}`
- **ഉപയോഗം**: Admin Panel (`admin.html`), TV Control (`tv-control.html`) എന്നിവയിലേക്കുള്ള പ്രധാന അനുമതി പരിശോധന.
- **Fields**: `email` (`string`), `username` (`string`), `displayName` (`string`), `role` (`string`: `"admin"` | `"superAdmin"`), `active` (`boolean`), `createdAt` (`number`), `updatedAt` (`number`).

#### 2. `adminUsernames/{username}`
- **ഉപയോഗം**: Legacy/Console Admin username → email ലുക്കപ്പ്.
- **Fields**: `email` (`string`), `uid` (`string`), `active` (`boolean`).

#### 3. `accessUsers/{uid}`
- **ഉപയോഗം**: Admin Panel-ലെ Staff Access വഴി സൃഷ്ടിക്കുന്ന **Team Leaders**, **Judges**, **Admins** എന്നിവരുടെ പ്രൊഫൈൽ.
- **Fields**:
  - `username` (`string`)
  - `email` (`string`)
  - `displayName` (`string`)
  - `role` (`string`: `"teamLeader"` | `"judge"` | `"admin"` | `"superAdmin"`)
  - `team` (`string` — Team Leader ആണെങ്കിൽ നിർബന്ധം, ഉദാ. `"Red"`)
  - `genderScope` (`string`: `"Boys"` | `"Girls"` | `"Both"`)
  - `title` (`string`)
  - `phone` (`string`)
  - `photoUrl` (`string`)
  - `authUid` (`string`)
  - `accessDocId` (`string`)
  - `active` (`boolean`)
  - `createdAt` (`number`)
  - `updatedAt` (`number`)

#### 4. `accessUsernames/{username}` & `accessUsernames/email_{escaped}`
- **ഉപയോഗം**: `login.html`-ൽ username അല്ലെങ്കിൽ email നൽകുമ്പോൾ കൃത്യമായ Firebase Auth email കണ്ടെത്താൻ.
- **Fields**: `username` (`string`), `email` (`string`), `role` (`string`), `team` (`string`), `genderScope` (`string`), `active` (`boolean`), `accessDocId` (`string`).

#### 5. `teamLeaders/{leaderId}`
- **ഉപയോഗം**: പബ്ലിക് ഹോം പേജിൽ Team Leaders വിവരങ്ങൾ കാണിക്കാൻ (Public Read allowed).
- **Fields**: `displayName` (`string`), `username` (`string`), `team` (`string`), `genderScope` (`string`), `title` (`string`), `phone` (`string`), `photoUrl` (`string`), `active` (`boolean`), `updatedAt` (`number`).

#### 6. `judges/{judgeId}`
- **ഉപയോഗം**: Judge ഡയറക്ടറി (Admin & assigned Judge മാത്രം വായിക്കും).
- **Fields**: `displayName` (`string`), `username` (`string`), `email` (`string`), `title` (`string`), `phone` (`string`), `active` (`boolean`), `updatedAt` (`number`).

---

### B. Configuration Documents (`settings` Collection)

`settings` എന്ന Collection-ന് ഉള്ളിൽ ഓരോ പേരിലും ഓരോ Document ആണ് ഉണ്ടാകുക (ഇവ Admin Panel → Setup / Results / TV Control വഴി സ്വയം സൃഷ്ടിക്കപ്പെടും).

#### 1. `settings/home_config`
- `festName1` (`string`): ഉദാ. `"KALOLSAVAM"`
- `festName2` (`string`): ഉദാ. `"2025"`
- `tagline` (`string`): ടാഗ്‌ലൈൻ
- `aboutSubtitle` (`string`): About സബ്-ഹെഡിംഗ്
- `aboutText` (`string`): ഫെസ്റ്റ് വിവരണം
- `footerText` (`string`): ഫൂട്ടർ വാചകം
- `logoUrl` (`string`): ലോഗോ URL അല്ലെങ്കിൽ compressed Base64 data URL
- `galleryImages` (`array` of `string`): ഗാലറി ഇമേജ് URL-കളുടെ ലിസ്റ്റ്
- `setupCompleted` (`boolean`): `true`
- `updatedAt` (`number`): Epoch ms

#### 2. `settings/general`
- `teams` (`array` of `string`): ഉദാ. `["Red", "Blue", "Green"]`
- `teamColors` (`map`): ടീം നിറങ്ങൾ (`string` values). ഉദാ. `{ "Red": "#dc2626", "Blue": "#2563eb" }`
- `teamDisplayNames` (`map`): ടീം ഡിസ്പ്ലേ പേരുകൾ (`string` values). ഉദാ. `{ "Red": "Red House" }`
- `categories` (`array` of `string`): ഉദാ. `["Sub Junior", "Junior", "Senior"]`
- `stages` (`array` of `string`): ഉദാ. `["Stage 1", "Stage 2"]`
- `days` (`array` of `map`): ഓരോ ദിവസവും ഒരു Map ആയി. ഉദാ. `[{ "date": "2025-11-20", "label": "Day 1" }]`
- `festSetup` (`map`): സ്ഥാപന ഫെസ്റ്റ് നിയമങ്ങളുടെ optional config map
- `updatedAt` (`number`): Epoch ms

#### 3. `settings/registration_config`
- `globalStatus` (`string`): `"open"` | `"closed"`
- `studentApplicationsEnabled` (`boolean`): `true` | `false`
- `registrationPortalEnabled` (`boolean`): `true` | `false`
- `finalizationLockAt` (`number`): Epoch ms (`0` = ലോക്ക് ഇല്ല)
- `allowApplicationMediaReplace` (`boolean`)
- `allowApplicationMediaAddMissing` (`boolean`)
- `participationLimits` (`map`):
  - `single` (`map`): `{ "enabled": boolean, "mode": string, "limit": number }`
  - `group` (`map`): `{ "enabled": boolean, "mode": string, "limit": number }`
  - `total` (`map`): `{ "enabled": boolean, "mode": string, "limit": number }`
- `updatedAt` (`number`)

#### 4. `settings/schedule_config`
- `registrationLockAt` (`number` or `null`): ഈ സമയത്തിന് ശേഷം Team Leaders-ന് രജിസ്ട്രേഷൻ മാറ്റാനാവില്ല (`firestore.rules` ഇത് പരിശോധിക്കുന്നു).
- `updatedAt` (`number`)

#### 5. `settings/scoring_rules`
- `enabled` (`map`): `{ "grades": boolean }`
- `policies` (`map`): `{ "multipleJudgeMethod": string }` (ഉദാ. `"average"`)
- `configs` (`map`):
  - `Single` (`map`): `{ "points": array of map [{ "place": 1, "label": "First", "value": 5 }, ...] }`
  - `Group` (`map`): `{ "points": array of map [{ "place": 1, "label": "First", "value": 10 }, ...] }`
- `grades` (`array` of `map`): ഉദാ. `[{ "grade": "A", "minPercent": 80, "points": 5 }]`
- `updatedAt` (`number`)

#### 6. `settings/tv_config`
- `title` (`string`): TV ഹെഡർ ടൈറ്റിൽ
- `ticker` (`string`): താഴെ ഓടുന്ന Ticker വാചകം
- `announcements` (`array` of `string`): അനൗൺസ്മെന്റുകൾ
- `interruptPolicy` (`string`): `"after-current"` | `"immediate"`
- `show` (`map`): ഓരോ TV സെക്ഷനും കാണിക്കണോ വേണ്ടയോ എന്ന `boolean` map (`results`, `leaderboard`, `announcements`, `ticker`, `clock`, `logo`, `name`, `subtitle`, `media`, `videos`)
- `sections` (`map` of `map`): ഓരോ സെക്ഷന്റെയും `{ "visible": boolean, "order": number }`
- `background` (`map`):
  - `color` (`string`): ഉദാ. `"#0B1120"`
  - `imageUrl` (`string`)
  - `videoUrl` (`string`)
  - `slides` (`array` of `string`)
  - `videos` (`array` of `string`)
- `updatedAt` (`number`)
- `updatedByUid` (`string`)

#### 7. `settings/tv_control` *(മറ്റും `settings/tv_control_draft`)*
- `mode` (`string`): `"dashboard"` | `"results"` | `"media"` | `"video-only"`
- `animationStyle` (`string`): `"cinematic"` | `"spotlight"` | `"ticker-rise"` | `"confetti"`
- `resultOrder` (`string`): `"latest"` | `"oldest"` | `"selected"`
- `selectedResultIds` (`array` of `string`)
- `content` (`map` of `boolean`)
- `sections` (`map` of `map`)
- `interruptPolicy` (`string`)
- `afterQueue` (`string`)
- `videoUrls` (`array` of `string`)
- `videoUrl` (`string`)
- `imageUrls` (`array` of `string`)
- `updatedAt` (`number`)
- `updatedByUid` (`string`)

#### 8. `settings/public_summary`
- **ഉപയോഗം**: പബ്ലിക് ഹോം പേജിലെ Blaze Firestore Read-കൾ കുറയ്ക്കാൻ Admin Panel സ്വയം അപ്‌ഡേറ്റ് ചെയ്യുന്ന summary.
- `studentCount` (`number`): ആകെ വിദ്യാർത്ഥികൾ
- `publishedCount` (`number`): പ്രസിദ്ധീകരിച്ച ഫലങ്ങൾ
- `teamScores` (`map`): ഓരോ ടീമിന്റെയും പോയിന്റ് (`{ "Red": 120, "Blue": 105 }`)
- `updatedAt` (`number`)

---

### C. Core Operational Collections

#### 1. `students/{studentId}`
- `name` (`string` — max 140 chars, നിർബന്ധം)
- `team` (`string` — നിർബന്ധം)
- `category` (`string`)
- `gender` (`string`: `"Boys"` | `"Girls"`)
- `chestNo` (`string` or `number` — Letters/Numbers/`_`/`-` only, max 32 chars)
- `photoData` (`string` — `data:image/(jpeg|png|webp|gif);base64,...` format, max 280KB)
- `showPhotoInResults` (`boolean`)
- `details` (`map`)
- `importedAt` (`number`)
- `updatedAt` (`number`)

#### 2. `events/{eventId}`
- `name` (`string` — max 160 chars, നിർബന്ധം)
- `category` (`string`)
- `gender` (`string`: `"Boys"` | `"Girls"` | `"Both"` | `"Mixed"`)
- `type` (`string`: `"Single"` | `"Group"`)
- `stage` (`string`: `"On-Stage"` | `"Off-Stage"`)
- `limit` (`number` — ഒരു ടീമിന് അനുവദിക്കുന്ന പരമാവധി എൻട്രികൾ)
- `groupSize` (`number`), `minimumMembers` (`number`), `maximumMembers` (`number`)
- `allowedParticipantTypes` (`array` of `string`)
- `allowedRegistrationChannels` (`array` of `string`)
- `resultMethod` (`string`)
- `maximumMark` (`number`)
- `criteria` (`array` of `map`): ഉദാ. `[{ "name": "Presentation", "maxMark": 25 }]`
- `scheduleDate` (`string`), `scheduleDay` (`string`), `scheduleDayId` (`string`)
- `scheduleStage` (`string`), `scheduleStageId` (`string`)
- `time` (`string`), `scheduleEndTime` (`string`), `scheduleDuration` (`number`), `scheduleOrder` (`number`), `scheduleStatus` (`string`), `scheduleNotes` (`string`)
- `cancelled` (`boolean`), `cancelReason` (`string`), `cancelledAt` (`number`), `cancelledByUid` (`string`)
- `status` (`string`), `updatedAt` (`number`)

#### 3. `scheduleBreaks/{breakId}`
- `title` (`string`), `date` (`string`), `startTime` (`string`), `endTime` (`string`)
- `category` (`string`), `day` (`string`), `dayId` (`string`)
- `stage` (`string`), `stageId` (`string`), `stages` (`array` of `string`), `stageIds` (`array` of `string`)
- `duration` (`number`), `afterEventId` (`string`), `order` (`number`), `active` (`boolean`)
- `createdAt` (`number`), `updatedAt` (`number`)

#### 4. `registrations/{registrationId}`
- `eventId` (`string`), `eventName` (`string`)
- `team` (`string`)
- `managedGender` (`string`: `"Boys"` | `"Girls"` | `"Both"`)
- `slotIndex` (`number`)
- `studentIds` (`array` of `string` — Student document IDs)
- `participantIds` (`array` of `string`)
- `participantMeta` (`map`)
- `registrationSource` (`string`)
- `createdByUid` (`string`), `lastUpdatedByUid` (`string`)
- `createdAt` (`number`), `lastUpdatedAt` (`number`)

#### 5. `registrationRequests/{requestId}`
*(വിദ്യാർത്ഥികൾ `register.html` വഴി അയക്കുന്ന അപേക്ഷകൾ)*
- `name` (`string`), `participantType` (`string`: `"student"`), `gender` (`string`: `"Boys"` | `"Girls"`)
- `phone` (`string`), `email` (`string`), `team` (`string`), `category` (`string`)
- `relatedStudentId` (`string`), `relationship` (`string`)
- `groupMembers` (`array` of `string` / `map`)
- `eventIds` (`array` of `string` — 1 to 25 event IDs)
- `note` (`string`), `youtubeUrl` (`string`), `referenceUrl` (`string`)
- `images` (`array` of `map` — പരമാവധി 1 ഇമേജ് object `{ "data": "data:image/..." }`)
- `status` (`string` — തുടക്കത്തിൽ `"pending"`, പിന്നീട് `"selected"` / `"rejected"` / etc.)
- `submittedAt` (`number`)
- *(തീരുമാനത്തിന് ശേഷം)*: `decisionByUid` (`string`), `decisionByName` (`string`), `decisionByRole` (`string`), `decisionAt` (`number`), `reviewedAt` (`number`)

#### 6. `teamRegistrationPolicies/{teamId}`
- `team` (`string` — Document ID-ക്ക് തുല്യം)
- `mode` (`string`: `"open"` | `"unfilled_only"` | `"waitlist_only"` | `"closed"`)
- `changedByUid` (`string`)
- `updatedAt` (`number`)

#### 7. `judgeAssignments/{assignmentId}`
- `eventId` (`string`), `eventName` (`string`)
- `judgeId` (`string`), `judgeName` (`string`)
- `active` (`boolean`)
- `createdAt` (`number`), `updatedAt` (`number`)

#### 8. `judgeScores/{assignmentId}`
*(Document ID നിർബന്ധമായും `assignmentId` ആയിരിക്കണം)*
- `assignmentId` (`string`), `judgeId` (`string`), `eventId` (`string`)
- `status` (`string`: `"draft"` | `"submitted"`)
- `marks` (`array` of `map`): ഓരോ മത്സരാർത്ഥിയുടെയും/ഗ്രൂപ്പിന്റെയും മാർക്കുകൾ
- `publishStatus` (`string`: `"published"` — Admin പബ്ലിഷ് ചെയ്ത ശേഷം)
- `publishedResultId` (`string`), `publishedAt` (`number`)
- `updatedAt` (`number`)

#### 9. `publicJudgingStatuses/{assignmentId}`
- `assignmentId` (`string`), `eventId` (`string`), `status` (`string`: `"submitted"`), `submittedAt` (`number`)

#### 10. `results/{eventId}`
*(പബ്ലിക് പേജുകളിലും TV-യിലും extra student reads ഒഴിവാക്കാൻ `winnerDetails` ഇതിൽ തന്നെ സംരക്ഷിക്കുന്നു)*
- `eventId` (`string`), `eventName` (`string`), `category` (`string`), `stage` (`string`), `gender` (`string`), `type` (`string`)
- `status` (`string`: `"ready"` | `"published"` | `"archived"`)
- `places` (`array` of `map`): ഉദാ. `[{ "place": 1, "label": "First", "winners": ["studentId1"], "value": 5, "earnedValue": 5 }]`
- `gradeAwards` (`array` of `map`): ഗ്രേഡ് പോയിന്റ് വിവരങ്ങൾ
- `winnerDetails` (`map` of `map`): ഓരോ വിജയിയുടെയും ID key ആക്കി `{ "name": string, "team": string, "chestNo": string, "photoData": string }`
- `scoringSnapshot` (`map`), `sourceType` (`string`)
- `publishedAt` (`number`), `updatedAt` (`number`), `publishedByUid` (`string`)

#### 11. Audit, Ledger & Backup Collections
- `resultRevisions/{revisionId}`: `eventId` (`string`), `revision` (`number`), `reason` (`string`), `previousPlaces` (`array`), `nextPlaces` (`array`), `actorUid` (`string`), `timestamp` (`number`)
- `teamScoreLedgers/{eventId}`: `eventId` (`string`), `eventName` (`string`), `entries` (`array` of `map`), `updatedAt` (`number`)
- `notifications/{notificationId}`: `team` (`string`: `"All"` അല്ലെങ്കിൽ team key), `title` (`string`), `message` (`string`), `createdAt` (`number`), `createdByUid` (`string`)
- `auditLogs/{logId}`: `action` (`string`), `eventId` (`string`), `eventName` (`string`), `sourceType` (`string`), `timestamp` (`number`), `uid` (`string`)
- `deletedBackups/{backupId}`: Reset നടത്തുന്നതിന് മുമ്പുള്ള ബാക്കപ്പ് ഡാറ്റ (Admin only)

---

## 5. സാധാരണ വരാറുള്ള പിശകുകളും പരിഹാരങ്ങളും (Troubleshooting)

1. **"This Firebase user is not enabled as an admin" എന്ന് കാണിക്കുന്നു**:
   - `adminUsers` Collection-ലെ Document ID നിങ്ങളുടെ Firebase Auth **User UID** തന്നെയാണോ എന്ന് ഉറപ്പാക്കുക.
   - `active` ഫീൽഡ് `string` (`"true"`) ആയിട്ടല്ല, **`boolean` (`true`)** ആയിട്ടാണ് സേവ് ചെയ്തിട്ടുള്ളതെന്ന് പരിശോധിക്കുക.
   - `role` ഫീൽഡ് കൃത്യമായി `"admin"` അല്ലെങ്കിൽ `"superAdmin"` ആണെന്ന് ഉറപ്പാക്കുക.
2. **ലോഗിൻ ചെയ്യുമ്പോൾ "auth/unauthorized-domain" പിശക്**:
   - Firebase Console → **Authentication → Settings → Authorized domains**-ൽ നിങ്ങളുടെ Vercel URL (`*.vercel.app`) ചേർത്തിട്ടുണ്ടോ എന്ന് പരിശോധിക്കുക.
3. **Permission Denied പിശക് (ഡാറ്റ സേവ് ചെയ്യുമ്പോൾ)**:
   - `firestore.rules` കൃത്യമായി **Publish** ചെയ്തിട്ടുണ്ടോ എന്ന് പരിശോധിക്കുക.
   - മാനുവലായി ഡോക്യുമെന്റുകൾ ചേർത്തപ്പോൾ `*At` ഫീൽഡുകൾ `timestamp`-ന് പകരം **`number`** ആണെന്ന് ഉറപ്പാക്കുക.
