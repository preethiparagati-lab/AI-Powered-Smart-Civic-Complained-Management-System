# CivicLens – AI-Powered Smart Civic Complaint Management

Citizens photograph a civic problem; AI suggests the category and drafts the complaint; the citizen
confirms, pins the location and submits. Administrators triage, assign, prioritise and resolve.

## Features
| # | Feature | Where |
|---|---------|-------|
| 1 | Registration, login, profile | Firebase Auth, `#/login`, `#/my` |
| 2 | AI photo-to-complaint (category + draft description) | `js/ai.js` (TF.js) |
| 3 | GPS location + interactive map pin | Leaflet / OpenStreetMap |
| 4 | Custom complaint ("Other" + own title) | Report form |
| 5 | Duplicate detection (image embedding + distance) | `findDuplicates` in `js/app.js` |
| 6 | AI-assisted resolution verification (before vs after) | Admin panel on complaint page |
| 7 | Civic issue map with filters | `#/map` |
| 8 | Smart escalation (SLA deadlines, overdue levels 1–3, manual escalate) | `js/config.js`, dashboard |
| 9 | Status tracking + reference IDs + feedback | `#/track`, complaint page |
| 10 | Admin dashboard (stats, filters, hot-spots, assignment) | `#/admin` |

## How the AI works (and its limits)
- **In the browser** with TensorFlow.js, so it deploys on Vercel as static files (no Python server needed).
- MobileNetV2 produces an *embedding* of each photo. Duplicate detection = same area (default 100 m) **and** high
  cosine similarity (or same category nearby, shown as "possible"). Resolution check = how different the *after* photo
  is from the *before* photo, plus the trained model (if present) no longer seeing the issue.
- Category suggestion: without a custom model the app maps generic ImageNet labels to civic categories (**weak**).
  For real accuracy train the Keras model in `ml/` on your own labelled photos – see below.
- All AI output is a draft/suggestion. Citizens edit it; admins confirm resolutions.
- Submitting here records the complaint in this platform. Forwarding to a municipal body needs an authorised integration.

## Setup (≈15 minutes)
### 1. Firebase
1. Create a project at <https://console.firebase.google.com>.
2. **Authentication → Sign-in method →** enable **Email/Password**.
3. **Firestore Database →** create (production mode), then **Rules →** paste `firestore.rules` → Publish.
4. **Storage →** get started, **Rules →** paste `storage.rules` → Publish.
   *New projects need the Blaze (pay-as-you-go) plan for Storage; the free tier is generous.*
   **Prefer no billing?** Set `USE_STORAGE: false` in `js/config.js` – photos are then compressed and stored in Firestore.
   (If you do that, also remove the storage rules step.)
5. **Project settings → Your apps → Web app (`</>`)** → copy the config into `js/config.js`.
6. **Authentication → Settings → Authorized domains →** add your Vercel domain after the first deploy.
7. Register in the app, then in Firestore open `users/<your uid>` and change `role` from `citizen` to `admin`.

### 2. Run locally
```bash
npx serve .          # or: python3 -m http.server 8000
```
(ES modules need http://, not file://.)

### 3. GitHub
```bash
git init
git add .
git commit -m "CivicLens: AI civic complaint system"
git branch -M main
git remote add origin https://github.com/<you>/civiclens.git
git push -u origin main
```

### 4. Vercel
1. <https://vercel.com/new> → import the GitHub repo.
2. Framework preset: **Other**. Build command: *(empty)*. Output directory: *(empty / root)*.
3. Deploy. Every `git push` redeploys automatically.
4. Add the Vercel domain to Firebase Authorized domains (step 1.6).

### 5. Train the custom AI model (optional but recommended)
```bash
pip install tensorflow tensorflowjs
# put photos in ml/dataset/<category-id>/*.jpg  (see ml/train.py)
python ml/train.py
git add model && git commit -m "Add trained civic model" && git push
```

## Configuration (`js/config.js`)
Categories, departments, SLA hours per category, priority multipliers, duplicate radius/thresholds, map centre.

## Notes
- Firebase web keys are public by design; protection comes from the security rules included here.
- Reference IDs look like `CIV-20261014-7K2QX`.
- Unresolved complaints past `dueAt` are flagged Overdue (level 1: <24 h, 2: <72 h, 3: longer) and can be escalated manually.
  Changing priority recalculates the deadline.
- Photos carry embeddings (~1,280 numbers) in Firestore for similarity checks; complaints are publicly readable (for the map and tracking), so tell users not to photograph faces or number plates.
- OpenStreetMap tiles and Nominatim geocoding have usage policies; for heavy traffic use a commercial tile provider.

## Project structure
```
index.html          app shell
css/styles.css      styling (light + dark)
js/config.js        Firebase keys + categories/SLAs/thresholds
js/firebase.js      Firebase wrapper (+ image saving)
js/ai.js            TF.js: classify, embed, draft text, verify resolution
js/utils.js         helpers
js/app.js           router + all views
ml/train.py         Keras training + TF.js export
model/              exported custom model (optional)
firestore.rules  storage.rules  vercel.json
```
