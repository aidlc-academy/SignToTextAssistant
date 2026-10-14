# Development Guidelines — Sign-to-Text Communication Assistant

## Core rule: preserve working functionality

Before changing any file, identify which existing features it supports.
The six gesture rules, camera pipeline, SQLite history, Firestore history,
authentication, and text-to-speech are all working and must remain working
after every change.

## Python conventions

- Follow the existing style: snake_case, type hints on function signatures,
  docstrings on public functions.
- `gesture.py` must remain a pure module — no Flask imports, no I/O, no
  Firebase. It is called from both `app.py` and `main.py`.
- `classify_gesture(lm)` must always return `(label: str, confidence: float)`.
  Callers in `app.py` and `main.py` unpack this tuple; breaking the signature
  breaks both entry points.
- All SQLite queries in `database.py` must remain parameterised. Never use
  string interpolation to build SQL.
- Run `python -m py_compile <file>.py` to syntax-check any Python file before
  treating a change as done.

## JavaScript conventions

- `app.js` is loaded as a plain `<script>` (not a module). It cannot use
  `import`. Firebase helpers are received as `window.*` globals set by the
  `<script type="module">` auth guard in `index.html`.
- All other JS files (`auth.js`, `firestore.js`, `room.js`) are ES modules
  using the Firebase CDN at version **10.12.2**. Do not change the SDK version
  without updating all import URLs consistently across all three files.
- The `package.json` `"type"` field is `"commonjs"`. Test files use `require()`,
  not `import`.
- Do not introduce a bundler, transpiler, or npm frontend package. The
  frontend has no build step by design.

## Firebase and Firestore rules

- Never commit real Firebase credentials. `firebase-config.js` must contain
  only placeholder strings until the developer pastes their own values.
- The Firestore Security Rules in `firestore.rules` cover three paths:
  `users/{uid}/translations`, `rooms/{roomId}`, and
  `invitations/{emailHash}/pendingInvites/{inviteId}`.
  The personal history rule (`users/…`) must never be weakened.
- Any change to `firestore.rules` requires a matching test in
  `tests/firestore.rules.test.js`. Run the full test suite against the
  emulator before considering the change done.
- Use the Firestore Emulator (project ID `demo-signtotextassistant`) for
  all rules testing. Never point tests at the production project.
- The email hash in `room.js` uses `sha256hex()` which produces **uppercase**
  hex. The rules use `hashing.sha256(...).toHexString()` which also produces
  uppercase. These must stay consistent; changing one requires changing the other.

## Testing expectations

- The 49 existing tests in `tests/firestore.rules.test.js` must all continue
  to pass after any change to `firestore.rules` or the test file.
- Test setup uses `withSecurityRulesDisabled` (admin writes) for pre-conditions
  only. The operation being tested must always use an authenticated or
  unauthenticated context — never admin — so the rule is actually exercised.
- New rules changes require new tests. Add them as additional `it()` cases or
  new `describe` blocks; never delete existing tests.
- Verify the emulator is running on port 8080 before running `npm test`.

## Gesture classifier rules

- The six gestures (HELLO, STOP, OK, YES, ONE, VICTORY) and their landmark
  rules in `gesture.py` are the product's core classification logic.
  Do not add, remove, or rename gestures without explicit instruction.
- Threshold constants (`ADJACENT_HELLO`, `ADJACENT_STOP`, `THUMB_ABD_HELLO`,
  `THUMB_ABD_STOP`, `OK_TOUCH_THRESHOLD`) have been tuned against real hand
  poses. Changes need justification and emulator or live testing.
- `hand_landmarker.task` is a required binary asset. Do not delete or replace
  it. It is loaded at startup by both `app.py` and `main.py` from the path
  `MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hand_landmarker.task")`.

## What not to do

- Do not deploy Firestore rules or Firebase hosting without explicit instruction.
- Do not add `admin` SDK usage to the client-side JS files. The project uses
  the Firebase client SDK only.
- Do not implement or claim real-time messaging, WebRTC video calling, or
  remote gesture translation — these are not yet implemented.
- Do not modify `firestore.rules` without also updating `tests/firestore.rules.test.js`.
- Do not store secrets (API keys, private keys, passwords) in any file.
- Do not remove or disable the `guardPage()` auth check in `index.html`.
  All dashboard access must be authenticated.

## Online Communication mode boundaries

The `#panel-online` UI and `room.js` implement Phase 1 (room creation and
invitation flow) only. When working in this area:

- Do not modify the `#panel-local` section or any feature in `app.js`,
  `firestore.js`, or `auth.js` unless explicitly required.
- Room Firestore writes go to `rooms/{roomId}` and
  `invitations/{emailHash}/pendingInvites/{roomId}`.
  Do not use or create other collection paths without updating `firestore.rules`.
- The active room view (`#view-room`) currently shows a placeholder.
  Do not add messaging or video functionality until the Phase 1 remediation
  items (invitation expiry, orphaned room cleanup, cancelRoom refresh fix)
  are complete and tested.
