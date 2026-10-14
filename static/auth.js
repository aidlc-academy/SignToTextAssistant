/**
 * auth.js
 * -------
 * Firebase Authentication logic for the Sign-to-Text Communication Assistant.
 *
 * Responsibilities
 * ────────────────
 * - Initialise the Firebase app using the config from firebase-config.js
 * - Export a ready-to-use `auth` object (shared by all pages)
 * - signIn(email, password)     → used by login.html
 * - register(email, password)   → used by register.html
 * - signOutUser()               → used by index.html sign-out button
 * - guardPage()                 → redirects unauthenticated users to /login
 * - showAuthUser(displayEl)     → writes the signed-in email into a DOM element
 *
 * This file uses the Firebase JS SDK v10 loaded from the CDN as ES modules.
 * No npm, no bundler, no build step required.
 */

// ── Firebase SDK imports (CDN — ES module syntax) ────────────────────────────
import { initializeApp }                           from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth,
         createUserWithEmailAndPassword,
         signInWithEmailAndPassword,
         signOut,
         onAuthStateChanged }                      from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

// ── Initialise Firebase ───────────────────────────────────────────────────────
//
// initializeApp() is safe to call multiple times with the same config because
// Firebase returns the already-initialised app on repeat calls.
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);

// ── Register a new user ───────────────────────────────────────────────────────
/**
 * Create a new account with email and password.
 * Returns the Firebase UserCredential on success.
 * Throws a Firebase AuthError on failure (caller must catch).
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import("firebase/auth").UserCredential>}
 */
async function register(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

// ── Sign in an existing user ──────────────────────────────────────────────────
/**
 * Sign in with email and password.
 * Returns the Firebase UserCredential on success.
 * Throws a Firebase AuthError on failure (caller must catch).
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import("firebase/auth").UserCredential>}
 */
async function signIn(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

// ── Sign out the current user ─────────────────────────────────────────────────
/**
 * Sign out and redirect to /login.
 */
async function signOutUser() {
  await signOut(auth);
  window.location.href = "/login";
}

// ── Auth guard ────────────────────────────────────────────────────────────────
/**
 * Call this on any page that requires authentication (e.g. index.html).
 *
 * How it works:
 *   - onAuthStateChanged fires once as soon as Firebase resolves the session.
 *   - If no user is signed in, the visitor is redirected to /login immediately.
 *   - If a user IS signed in, the callback receives the user object and the
 *     caller can proceed to show the page.
 *
 * @param {function(import("firebase/auth").User): void} onAuthed
 *   Callback invoked with the signed-in User when auth is confirmed.
 */
function guardPage(onAuthed) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.href = "/login";
    } else {
      onAuthed(user);
    }
  });
}

// ── Show signed-in user email in a DOM element ────────────────────────────────
/**
 * Writes the signed-in user's email into `displayEl.textContent`.
 * Does nothing if the element is null.
 *
 * @param {HTMLElement|null} displayEl
 */
function showAuthUser(displayEl) {
  onAuthStateChanged(auth, (user) => {
    if (displayEl && user) {
      displayEl.textContent = user.email;
    }
  });
}

// ── Translate Firebase error codes into readable messages ─────────────────────
/**
 * Convert a Firebase AuthError code into a short, user-friendly message.
 * Falls back to the raw Firebase message if the code is not recognised.
 *
 * @param {import("firebase/auth").AuthError} error
 * @returns {string}
 */
function authErrorMessage(error) {
  const messages = {
    "auth/invalid-email":            "Please enter a valid email address.",
    "auth/user-not-found":           "No account found with that email.",
    "auth/wrong-password":           "Incorrect password. Please try again.",
    "auth/email-already-in-use":     "That email is already registered. Try logging in.",
    "auth/weak-password":            "Password must be at least 6 characters.",
    "auth/too-many-requests":        "Too many attempts. Please wait a moment and try again.",
    "auth/network-request-failed":   "Network error. Check your connection and try again.",
    "auth/invalid-credential":       "Invalid email or password.",
  };
  return messages[error.code] || error.message;
}

// ── Exports ───────────────────────────────────────────────────────────────────
export { auth, register, signIn, signOutUser, guardPage, showAuthUser, authErrorMessage };
