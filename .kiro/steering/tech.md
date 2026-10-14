# Tech Stack — Sign-to-Text Communication Assistant

## Backend (Python)

| Component | Detail |
|-----------|--------|
| Language | Python 3.14.6 |
| Web framework | Flask 3.1.3 |
| Computer vision | mediapipe 1.1.0 (also installs opencv-contrib-python) |
| ML model file | `hand_landmarker.task` (~7.8 MB, MediaPipe tasks API) |
| Local database | SQLite via `sqlite3` stdlib — `history.db` |
| Entry point (web) | `app.py` — `python app.py` starts Flask on `127.0.0.1:5000` |
| Entry point (standalone) | `main.py` — OpenCV window, no Flask, no Firebase |

Python dependencies are declared in `requirements.txt`:
```
mediapipe>=1.1.0
flask>=3.1.0
pyttsx3>=2.90   # optional offline TTS, not used in web mode
```

## Frontend (Vanilla HTML / CSS / JS)

No build step, no bundler, no npm package for the frontend itself.
All Firebase SDK imports use the CDN ES module pattern:
```
https://www.gstatic.com/firebasejs/10.12.2/firebase-*.js
```

| File | Purpose |
|------|---------|
| `static/app.js` | Camera controls, gesture label, SQLite polling, history render, TTS |
| `static/auth.js` | Firebase Auth SDK wrapper (sign-in, register, sign-out, guard) |
| `static/firestore.js` | Firestore history: mirror, subscribe, unsubscribe, clear |
| `static/room.js` | Room creation, invitation flow, room status listener |
| `static/firebase-config.js` | Firebase project config object (must be filled in by developer) |
| `static/style.css` | Dark-theme CSS custom properties; all UI styles |
| `static/auth.css` | Styles for login.html and register.html only |
| `templates/index.html` | Main dashboard (Local + Online tabs) |
| `templates/login.html` | Email/password sign-in page |
| `templates/register.html` | Email/password registration page |

## Firebase (client-side only)

| Service | Usage |
|---------|-------|
| Firebase Authentication | Email/Password only. No Google sign-in. |
| Cloud Firestore | Per-user translation history + room/invitation documents |
| Firebase JS SDK | Version 10.12.2 (CDN, ES modules, `type="module"` scripts) |

### Firestore collections

| Path | Purpose |
|------|---------|
| `users/{uid}/translations/{id}` | Per-user gesture history |
| `rooms/{roomId}` | Online communication room documents |
| `invitations/{emailHash}/pendingInvites/{roomId}` | Room invitations indexed by SHA-256 of invitee email |

Security rules are in `firestore.rules`. The emulator project ID is
`demo-signtotextassistant` (the `demo-` prefix prevents production connections).

## Node.js / Testing

Used only for Firestore Security Rules unit tests. Not required to run the app.

| Package | Version | Purpose |
|---------|---------|---------|
| `@firebase/rules-unit-testing` | 6.0.0 | Emulator-based rules testing |
| `firebase` | 13.0.0 | Firestore SDK used inside tests |
| `mocha` | 12.0.3 | Test runner |

`package.json` type is `"commonjs"` — tests use `require()`.

## Development commands

### Run the web application
```powershell
cd d:\SingToTextAssistant
python app.py
# Open http://127.0.0.1:5000 in the browser
```

### Run the standalone OpenCV window (no Firebase)
```powershell
python main.py
```

### Install Python dependencies
```powershell
pip install -r requirements.txt
```

### Run Firestore Security Rules tests

Terminal 1 — start emulator (leave running):
```powershell
firebase emulators:start --only firestore
```

Terminal 2 — run tests:
```powershell
npm test
# Runs: mocha tests/firestore.rules.test.js --timeout 15000
```

### Install Node.js test dependencies (first time only)
```powershell
npm install
```

## Architecture notes

- The Flask server opens `cv2.VideoCapture(0)` in a background thread.
  MediaPipe gesture classification runs server-side; results are polled by
  the browser at 300 ms intervals via `GET /gesture`.
- New gestures are saved to SQLite server-side, then the browser polls
  `GET /history?after_id=N` and mirrors new rows to Firestore.
- Firestore `onSnapshot` drives the history panel render — SQLite is not
  read for display, only for detection.
- `static/app.js` is loaded as a plain `<script>` (not a module). Firebase
  helpers are exposed to it via `window.*` globals set in the `<script type="module">`
  auth guard block in `index.html`.
