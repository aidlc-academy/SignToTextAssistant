/**
 * firebase-config.js
 * ------------------
 * Firebase project configuration for the Sign-to-Text Communication Assistant.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ACTION REQUIRED — paste your real Firebase config values below.        ║
 * ║                                                                          ║
 * ║  Where to find them:                                                     ║
 * ║    Firebase Console → Project Settings → Your apps                       ║
 * ║    → SDK setup and configuration → select "Config"                       ║
 * ║                                                                          ║
 * ║  Replace every string that starts with "PASTE_YOUR_" with the           ║
 * ║  corresponding value from your firebaseConfig object.                    ║
 * ║                                                                          ║
 * ║  These values are safe to include in frontend code — they identify       ║
 * ║  your project to Firebase but do not grant admin access.                 ║
 * ║  Never paste service-account credentials or private keys here.           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

// ── Paste your Firebase config here ─────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyAjFsGErsuv9ireUkRAQWz6ltuK72nHEqA",
  authDomain:        "signtotextassistant.firebaseapp.com",
  projectId:         "signtotextassistant",
  storageBucket:     "signtotextassistant.firebasestorage.app",
  messagingSenderId: "1010132263526",
  appId:             "1:1010132263526:web:b4d9b3ec5407b315c083a7"
  // measurementId is optional — include it only if your project uses Analytics
};
// ── End of config ────────────────────────────────────────────────────────────

export { firebaseConfig };
