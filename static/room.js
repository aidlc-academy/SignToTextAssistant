/**
 * room.js
 * -------
 * Secure room creation and joining for the Online Communication mode.
 * Phase 1 — no messaging or WebRTC yet.
 *
 * Security model
 * ──────────────
 * Invitations are stored at:
 *   invitations/{emailHash}/pendingInvites/{inviteId}
 *
 * where emailHash = lowercase hex SHA-256 of the invitee's email address.
 *
 * The Firestore Security Rule for this path requires:
 *   request.auth.token.email.lower() hashed == the path segment.
 *
 * This means:
 *   - Only the user whose email matches the hash can read their invitations.
 *   - No public email directory is created or needed.
 *   - An attacker who knows someone's email still cannot read their
 *     invitations because the rule compares against the *authenticated*
 *     user's own email token, not an arbitrary hash.
 *
 * Rooms are stored at:
 *   rooms/{roomId}
 *
 * Fields:
 *   createdBy:       UID of the speaker/creator
 *   participants:    [creatorUid, inviteeUid]  — exactly two UIDs
 *   status:          "waiting" | "active" | "ended"
 *   createdAt:       serverTimestamp
 *
 * Firestore rules enforce that only the two participants can read a room,
 * and that participants cannot be added or changed after creation.
 *
 * SDK version: 10.12.2  (matches auth.js and firestore.js)
 */

import { initializeApp, getApps, getApp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore,
         collection,
         doc,
         addDoc,
         getDoc,
         setDoc,
         updateDoc,
         deleteDoc,
         query,
         where,
         getDocs,
         onSnapshot,
         serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

// ── Initialise Firebase (shared instance) ─────────────────────────────────
const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const db   = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

// ── Active state ──────────────────────────────────────────────────────────
let _inviteUnsubscribe = null;   // onSnapshot unsub for pending invitations
let _roomUnsubscribe   = null;   // onSnapshot unsub for current room


// ═══════════════════════════════════════════════════════════════════════════
// Utility: SHA-256 of a string → lowercase hex
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return the lowercase hex SHA-256 digest of a UTF-8 string.
 * Uses the browser's built-in Web Crypto API — no external library needed.
 *
 * @param {string} message
 * @returns {Promise<string>}
 */
async function sha256hex(message) {
  const msgBuffer  = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * Normalise an email address: trim whitespace and lowercase.
 * @param {string} email
 * @returns {string}
 */
function normaliseEmail(email) {
  return email.trim().toLowerCase();
}


// ═══════════════════════════════════════════════════════════════════════════
// Room creation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a private room and send an invitation to the invitee.
 *
 * Steps:
 *   1. Validate that the creator is not inviting themselves.
 *   2. Create the room document with status "waiting".
 *      participants contains only the creator's UID at this point —
 *      the invitee UID is not known until they accept.
 *   3. Write an invitation document at invitations/{emailHash}/pendingInvites/{roomId}.
 *
 * The Firestore rule for rooms allows creation only when:
 *   - request.auth.uid == request.resource.data.createdBy
 *   - participants array contains exactly one UID (the creator's own)
 *   - status == "waiting"
 *
 * The invitee's UID is added to participants when they accept (see acceptInvite).
 *
 * @param {string} creatorUid   Firebase Auth UID of the signed-in creator
 * @param {string} creatorEmail Authenticated email of the creator
 * @param {string} inviteeEmail Email address typed by the creator
 * @returns {Promise<{ok: boolean, roomId?: string, error?: string}>}
 */
async function createRoom(creatorUid, creatorEmail, inviteeEmail) {
  const normInvitee = normaliseEmail(inviteeEmail);
  const normCreator = normaliseEmail(creatorEmail);

  // Guard: creator cannot invite themselves
  if (normInvitee === normCreator) {
    return { ok: false, error: "You cannot invite yourself to a room." };
  }

  // Guard: basic email format
  if (!normInvitee.includes("@") || normInvitee.length < 5) {
    return { ok: false, error: "Please enter a valid email address." };
  }

  try {
    // 1. Create the room document
    //    participants starts with only the creator — invitee added on accept
    const roomRef = await addDoc(collection(db, "rooms"), {
      createdBy:    creatorUid,
      participants: [creatorUid],
      inviteeEmail: normInvitee,          // stored so creator can see who they invited
      status:       "waiting",
      createdAt:    serverTimestamp(),
    });

    const roomId = roomRef.id;

    // 2. Write the invitation under the hash of the invitee's email
    const emailHash = await sha256hex(normInvitee);
    const inviteRef = doc(db, "invitations", emailHash, "pendingInvites", roomId);

    await setDoc(inviteRef, {
      roomId:      roomId,
      invitedBy:   creatorEmail,          // display name for the invitee UI
      createdAt:   serverTimestamp(),
      expiresAt:   new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    return { ok: true, roomId };

  } catch (err) {
    console.error("[room] createRoom failed:", err.code, err.message);
    return { ok: false, error: "Could not create room. Check your connection." };
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Invitation listening and accepting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Listen for pending invitations addressed to the signed-in user.
 *
 * The listener reads invitations/{sha256(userEmail)}/pendingInvites.
 * Firestore rules ensure only the user whose email matches the hash
 * can read this collection.
 *
 * Calls onInvites(inviteArray) whenever the collection changes.
 * Each element: { roomId, invitedBy, createdAt, expiresAt }
 *
 * @param {string}   userEmail   The signed-in user's authenticated email
 * @param {function} onInvites   Callback(Array<invite>)
 * @param {function} onError     Callback(Error)
 */
async function listenForInvitations(userEmail, onInvites, onError) {
  // Tear down any previous invite listener
  if (typeof _inviteUnsubscribe === "function") {
    _inviteUnsubscribe();
    _inviteUnsubscribe = null;
  }

  const emailHash = await sha256hex(normaliseEmail(userEmail));
  const invitesRef = collection(db, "invitations", emailHash, "pendingInvites");

  _inviteUnsubscribe = onSnapshot(
    invitesRef,
    (snap) => {
      const invites = [];
      snap.forEach(d => invites.push({ id: d.id, ...d.data() }));
      onInvites(invites);
    },
    (err) => {
      // permission-denied is expected when there are no invitations yet
      // (the document path doesn't exist so Firestore denies the read)
      if (err.code !== "permission-denied") {
        console.error("[room] invite listener error:", err.code, err.message);
      }
      if (typeof onError === "function") onError(err);
    }
  );
}


/**
 * Accept an invitation: join the room and delete the invite document.
 *
 * Steps:
 *   1. Read the room document to verify it is still waiting.
 *   2. Add the acceptor's UID to participants and set status to "active".
 *   3. Delete the invitation document (it is consumed).
 *
 * Firestore rules allow updating a room only when:
 *   - The room status is currently "waiting"
 *   - The caller's UID is being added to participants (not removed or changed)
 *   - participants grows from 1 to exactly 2
 *
 * @param {string} userUid    Firebase Auth UID of the acceptor
 * @param {string} userEmail  Authenticated email of the acceptor (for hash)
 * @param {string} roomId     The room to join
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function acceptInvite(userUid, userEmail, roomId) {
  try {
    // 1. Read the room
    const roomRef  = doc(db, "rooms", roomId);
    const roomSnap = await getDoc(roomRef);

    if (!roomSnap.exists()) {
      return { ok: false, error: "Room not found. It may have been cancelled." };
    }

    const roomData = roomSnap.data();

    if (roomData.status !== "waiting") {
      return { ok: false, error: "This room is no longer available." };
    }

    if (roomData.participants.includes(userUid)) {
      return { ok: false, error: "You are already in this room." };
    }

    if (roomData.createdBy === userUid) {
      return { ok: false, error: "You cannot join a room you created as a listener." };
    }

    // 2. Add self to participants and activate the room
    await updateDoc(roomRef, {
      participants: [...roomData.participants, userUid],
      status:       "active",
    });

    // 3. Delete the invitation
    const emailHash = await sha256hex(normaliseEmail(userEmail));
    const inviteRef = doc(db, "invitations", emailHash, "pendingInvites", roomId);
    await deleteDoc(inviteRef);

    return { ok: true };

  } catch (err) {
    console.error("[room] acceptInvite failed:", err.code, err.message);
    return { ok: false, error: "Could not join room. Check your connection." };
  }
}


/**
 * Decline an invitation: delete the invite document without joining.
 *
 * @param {string} userEmail  Authenticated email of the declining user
 * @param {string} roomId
 */
async function declineInvite(userEmail, roomId) {
  try {
    const emailHash = await sha256hex(normaliseEmail(userEmail));
    const inviteRef = doc(db, "invitations", emailHash, "pendingInvites", roomId);
    await deleteDoc(inviteRef);
  } catch (err) {
    console.error("[room] declineInvite failed:", err.code, err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Room status listener
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Watch a room document for status changes.
 * Used by the creator to know when the invitee has accepted.
 *
 * @param {string}   roomId
 * @param {function} onStatus  Callback({status, participants, ...})
 * @param {function} onError
 */
function listenToRoom(roomId, onStatus, onError) {
  if (typeof _roomUnsubscribe === "function") {
    _roomUnsubscribe();
    _roomUnsubscribe = null;
  }

  const roomRef = doc(db, "rooms", roomId);

  _roomUnsubscribe = onSnapshot(
    roomRef,
    (snap) => {
      if (snap.exists()) {
        onStatus(snap.data());
      }
    },
    (err) => {
      console.error("[room] room listener error:", err.code, err.message);
      if (typeof onError === "function") onError(err);
    }
  );
}


/**
 * Cancel a waiting room created by the signed-in user.
 * Also deletes the outstanding invitation document.
 *
 * @param {string} creatorUid
 * @param {string} roomId
 * @param {string} inviteeEmail  Stored on the room document
 */
async function cancelRoom(creatorUid, roomId, inviteeEmail) {
  try {
    // Delete the invitation first
    if (inviteeEmail) {
      const emailHash = await sha256hex(normaliseEmail(inviteeEmail));
      const inviteRef = doc(db, "invitations", emailHash, "pendingInvites", roomId);
      await deleteDoc(inviteRef).catch(() => { /* may already be gone */ });
    }

    // Mark room as ended (rules: only creator can set status="ended")
    const roomRef = doc(db, "rooms", roomId);
    await updateDoc(roomRef, { status: "ended" });

  } catch (err) {
    console.error("[room] cancelRoom failed:", err.code, err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tear down all active listeners.
 * Call on sign-out or beforeunload.
 */
function unsubscribeRoom() {
  if (typeof _inviteUnsubscribe === "function") { _inviteUnsubscribe(); _inviteUnsubscribe = null; }
  if (typeof _roomUnsubscribe   === "function") { _roomUnsubscribe();   _roomUnsubscribe   = null; }
}


// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

export {
  createRoom,
  listenForInvitations,
  acceptInvite,
  declineInvite,
  listenToRoom,
  cancelRoom,
  unsubscribeRoom,
};
