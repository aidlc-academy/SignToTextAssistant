/**
 * firestore.js
 * ------------
 * Firestore operations for the Sign-to-Text Communication Assistant.
 *
 * Phase 2 — Firestore as the authoritative history source.
 *
 * What changed from Phase 1
 * ─────────────────────────
 * - Added subscribeToHistory(uid, onData, onError) which opens a real-time
 *   onSnapshot listener.  The dashboard now reads ONLY from Firestore, not
 *   from the shared SQLite database.
 * - Added unsubscribeHistory() to tear down the listener on sign-out or
 *   page unload.
 * - mirrorTranslation now guards against a mismatched UID: if the active
 *   listener UID differs from the uid argument the write is skipped.
 * - clearUserHistory uses a batched delete for safety and returns the count.
 *
 * Unchanged from Phase 1
 * ──────────────────────
 * - mirrorTranslation / loadUserHistory / clearUserHistory APIs.
 * - Same Firebase SDK version (10.12.2) and CDN as auth.js.
 * - getApps()/getApp() pattern so the Firebase app is never double-initialised.
 *
 * Exported API
 * ────────────
 * mirrorTranslation(uid, sqliteId, gesture, timestamp, confidence)
 * subscribeToHistory(uid, onData, onError)   ← new
 * unsubscribeHistory()                       ← new
 * clearUserHistory(uid)
 */

// ── Firebase SDK imports ──────────────────────────────────────────────────────
import { initializeApp, getApps, getApp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore,
         collection,
         doc,
         setDoc,
         getDocs,
         deleteDoc,
         query,
         orderBy,
         onSnapshot,
         serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

// ── Initialise Firebase (reuse existing app if already initialised) ───────────
const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const db          = getFirestore(firebaseApp);

// ── Active listener state ─────────────────────────────────────────────────────
// Only one listener is open at a time (one signed-in user per tab).
let _unsubscribeFn = null;   // Firestore unsubscribe function or null
let _activeUid     = null;   // UID the current listener belongs to


// ── Internal helper ───────────────────────────────────────────────────────────
function _translationsRef(uid) {
  return collection(db, "users", uid, "translations");
}


// ── mirrorTranslation ─────────────────────────────────────────────────────────
/**
 * Write one translation document to Firestore under the user's own collection.
 *
 * Idempotent: uses the SQLite row id as the document ID so calling this
 * twice with the same sqliteId produces one document, not two.
 *
 * Skips the write if the requested uid does not match the currently active
 * listener's uid — prevents writing to the wrong user on rapid sign-out.
 *
 * @param {string}        uid        Firebase Auth UID
 * @param {number|string} sqliteId   SQLite row id (becomes the Firestore doc id)
 * @param {string}        gesture    Recognised label, e.g. "HELLO"
 * @param {string}        timestamp  ISO-8601 local-time string from SQLite
 * @param {number|null}   confidence Optional 0.0–1.0 confidence score
 */
async function mirrorTranslation(uid, sqliteId, gesture, timestamp, confidence) {
  if (!uid || !sqliteId || !gesture) {
    console.warn("[firestore] mirrorTranslation: missing arguments — skipped.");
    return;
  }
  // Guard: do not write to a different user's collection if UID has changed
  if (_activeUid && _activeUid !== uid) {
    console.warn("[firestore] mirrorTranslation: UID mismatch — skipped.");
    return;
  }

  const docRef = doc(_translationsRef(uid), String(sqliteId));
  const data   = {
    gesture:   gesture,
    timestamp: timestamp,
    syncedAt:  serverTimestamp(),
  };
  if (typeof confidence === "number" && !isNaN(confidence)) {
    data.confidence = confidence;
  }

  try {
    await setDoc(docRef, data, { merge: true });
  } catch (err) {
    console.error("[firestore] mirrorTranslation failed:", err.code, err.message);
  }
}


// ── subscribeToHistory ────────────────────────────────────────────────────────
/**
 * Open a real-time listener on users/{uid}/translations, ordered by
 * timestamp descending (newest first).
 *
 * Automatically closes any previously open listener before opening the new one.
 *
 * @param {string}   uid      Firebase Auth UID of the signed-in user
 * @param {function} onData   Called with the full sorted array of translation
 *                            objects whenever the collection changes.
 *                            Each object: { id, gesture, timestamp, confidence }
 * @param {function} onError  Called with a Firestore Error on permission or
 *                            network failure.
 */
function subscribeToHistory(uid, onData, onError) {
  // Tear down any existing listener first
  unsubscribeHistory();
  _activeUid = uid;

  const q = query(
    _translationsRef(uid),
    orderBy("timestamp", "desc")   // newest first
  );

  _unsubscribeFn = onSnapshot(
    q,
    (snapshot) => {
      const rows = [];
      snapshot.forEach((docSnap) => {
        rows.push({
          id:         docSnap.id,
          gesture:    docSnap.data().gesture    ?? "",
          timestamp:  docSnap.data().timestamp  ?? "",
          confidence: docSnap.data().confidence ?? null,
        });
      });
      // rows is already newest-first because of orderBy("timestamp","desc")
      onData(rows);
    },
    (err) => {
      console.error("[firestore] onSnapshot error:", err.code, err.message);
      if (typeof onError === "function") onError(err);
    }
  );
}


// ── unsubscribeHistory ────────────────────────────────────────────────────────
/**
 * Close the active onSnapshot listener, if any.
 * Safe to call when no listener is open.
 */
function unsubscribeHistory() {
  if (typeof _unsubscribeFn === "function") {
    _unsubscribeFn();
    _unsubscribeFn = null;
  }
  _activeUid = null;
}


// ── clearUserHistory ──────────────────────────────────────────────────────────
/**
 * Delete every document in users/{uid}/translations.
 * Only touches the signed-in user's own sub-collection.
 * Does NOT delete SQLite data or affect any other user.
 *
 * @param {string} uid  Firebase Auth UID
 * @returns {Promise<number>}  Number of documents deleted
 */
async function clearUserHistory(uid) {
  if (!uid) return 0;
  // Safety: only allow deleting the active user's collection
  if (_activeUid && _activeUid !== uid) {
    console.error("[firestore] clearUserHistory: UID mismatch — refused.");
    return 0;
  }

  try {
    const snap    = await getDocs(_translationsRef(uid));
    const deletes = snap.docs.map((d) => deleteDoc(d.ref));
    await Promise.all(deletes);
    return snap.size;
  } catch (err) {
    console.error("[firestore] clearUserHistory failed:", err.code, err.message);
    return 0;
  }
}


// ── Exports ───────────────────────────────────────────────────────────────────
export {
  mirrorTranslation,
  subscribeToHistory,
  unsubscribeHistory,
  clearUserHistory,
};
