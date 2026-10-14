# Project Structure — Sign-to-Text Communication Assistant

## Root directory

```
d:\SingToTextAssistant\
├── app.py                   # Flask web server and webcam capture thread
├── gesture.py               # Rule-based gesture classifier (shared by app.py and main.py)
├── database.py              # SQLite helpers: init_db, save_translation, get_history, clear_history
├── main.py                  # Standalone OpenCV window mode (no Flask, no Firebase)
├── hand_landmarker.task     # MediaPipe hand landmark model (~7.8 MB, required at runtime)
├── history.db               # SQLite database (auto-created on first run, gitignore candidate)
├── firestore.rules          # Firestore Security Rules (deploy via Firebase Console)
├── firebase.json            # Firebase CLI config: rules path + emulator ports
├── .firebaserc              # Firebase project alias: demo-signtotextassistant
├── requirements.txt         # Python dependencies
├── package.json             # Node.js test dependencies and npm test script
├── package-lock.json        # Locked Node.js dependency tree
├── README.md                # Basic project description (outdated — predates Firebase)
├── static/                  # Frontend assets served by Flask
├── templates/               # Jinja2 HTML templates served by Flask
├── tests/                   # Firestore Security Rules emulator tests
└── .venv/                   # Python virtual environment (not committed)
```

## `static/` — Frontend assets

| File | Responsibility |
|------|---------------|
| `app.js` | Main dashboard logic: camera start/stop, gesture label polling, SQLite new-gesture detection and Firestore mirroring, history panel render with date groups, text-to-speech. Loaded as a plain `<script>` (not a module). |
| `auth.js` | Firebase Auth ES module: `signIn`, `register`, `signOutUser`, `guardPage`, `showAuthUser`, `authErrorMessage`. Imported as `type="module"`. |
| `firestore.js` | Firestore ES module: `mirrorTranslation`, `subscribeToHistory`, `unsubscribeHistory`, `clearUserHistory`. Manages the `users/{uid}/translations` sub-collection. |
| `room.js` | Online Communication ES module (Phase 1): `createRoom`, `listenForInvitations`, `acceptInvite`, `declineInvite`, `listenToRoom`, `cancelRoom`, `unsubscribeRoom`. Manages `rooms/` and `invitations/` Firestore collections. SHA-256 email hashing via Web Crypto API. |
| `firebase-config.js` | Exports the `firebaseConfig` object. **Developer must paste real project values here.** Never commit credentials. |
| `style.css` | All dashboard styles. Dark theme via CSS custom properties. Covers: layout grid, cards, camera feed, chat bubbles, date separators, voice controls, auth bar, mode tabs, online panel. |
| `auth.css` | Styles for `login.html` and `register.html` only. Defines the same CSS custom properties as `style.css` independently. |

## `templates/` — HTML pages

| File | Responsibility |
|------|---------------|
| `index.html` | Main dashboard. Contains two mode panels: `#panel-local` (Local Translation, always shown by default) and `#panel-online` (Online Communication). Hosts the `switchTab()` plain-script and the `type="module"` auth guard that starts Firestore listeners and exposes `window.*` bridges to `app.js`. |
| `login.html` | Email/password login form. Imports `signIn` and `authErrorMessage` from `auth.js`. |
| `register.html` | Registration form with password confirmation. Imports `register` and `authErrorMessage` from `auth.js`. |

## Python modules

| File | Responsibility |
|------|---------------|
| `app.py` | Flask application. Runs the webcam capture in a background thread. Applies a 5-frame stability filter and saves confirmed gestures to SQLite. Exposes 9 HTTP endpoints (see `tech.md`). Imports `gesture.py` and `database.py`. |
| `gesture.py` | Pure classification logic. `classify_gesture(lm)` accepts 21 `NormalizedLandmark` objects and returns `(label, confidence)`. No Flask, no Firebase, no I/O. Shared by `app.py` and `main.py`. |
| `database.py` | Thin SQLite wrapper. One table: `translations(id, gesture, timestamp)`. All queries are parameterised. `DB_PATH` is resolved relative to the script location (`history.db`). |
| `main.py` | Standalone mode: opens the webcam with OpenCV, runs MediaPipe, displays an annotated window. Does not use Flask, SQLite, or Firebase. Imports `gesture.py`. |

## `tests/`

| File | Responsibility |
|------|---------------|
| `firestore.rules.test.js` | Mocha test suite for `firestore.rules`. Uses `@firebase/rules-unit-testing` v6 with the Firestore Emulator on `127.0.0.1:8080`. Project ID: `demo-signtotextassistant`. 49 test cases across 10 `describe` blocks covering personal history, room CRUD, and invitation CRUD. All Firestore operations under test use authenticated contexts, not admin bypass. |

## Runtime-only files (not committed)

| File | Notes |
|------|-------|
| `history.db` | Auto-created by `database.py` on first run. Contains shared SQLite gesture history used for server-side detection. |
| `firebase-debug.log` | Firebase CLI emulator log. |
| `firestore-debug.log` | Firestore emulator log. |
| `.venv/` | Python virtual environment. |
| `node_modules/` | Node.js test dependencies. |
| `__pycache__/` | Python bytecode cache. |
