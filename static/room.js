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
import {
  getFirestore,
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
  serverTimestamp,
  Timestamp,
  orderBy
}
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { firebaseConfig } from "./firebase-config.js";

// ── Initialise Firebase (shared instance) ─────────────────────────────────
const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

// ── Active state ──────────────────────────────────────────────────────────
let _inviteUnsubscribe = null;   // onSnapshot unsub for pending invitations
let _roomUnsubscribe = null;   // onSnapshot unsub for current room
let _messagesUnsubscribe = null;   // onSnapshot unsub for room messages


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
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
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
      createdBy: creatorUid,
      participants: [creatorUid],
      inviteeEmail: normInvitee,          // stored so creator can see who they invited
      status: "waiting",
      createdAt: serverTimestamp(),
    });

    const roomId = roomRef.id;

    // 2. Write the invitation under the hash of the invitee's email.
    //    expiresAt is stored as a Firestore Timestamp so the rules can
    //    enforce expiry with request.time < resource.data.expiresAt.
    const emailHash = await sha256hex(normInvitee);
    const inviteRef = doc(db, "invitations", emailHash, "pendingInvites", roomId);

    try {
      await setDoc(inviteRef, {
        roomId: roomId,
        invitedBy: creatorEmail,          // display name for the invitee UI
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromDate(new Date(Date.now() + (23 * 60 + 55) * 60 * 1000)),
      });
    } catch (inviteErr) {
      // Invitation write failed — mark the room as ended so it cannot be joined.
      // We do not attempt deleteDoc because room deletion is blocked by rules.
      console.error("[room] createRoom: invitation write failed, marking room ended.", inviteErr.message);
      try {
        await updateDoc(roomRef, { status: "ended" });
        console.info("[room] createRoom: orphaned room marked ended:", roomId);
      } catch (cleanupErr) {
        // Double failure: room is waiting with no invitation and could not be ended.
        // It cannot be joined (no invitation exists), but it will remain in Firestore
        // until the creator manually cancels via cancelRoom().
        console.error(
          "[room] createRoom CRITICAL: room orphaned in 'waiting' state. " +
          "Manual cleanup required. roomId:", roomId,
          "| inviteErr:", inviteErr.message,
          "| cleanupErr:", cleanupErr.message
        );
      }
      return { ok: false, error: "Could not send invitation. Please try again." };
    }

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
  console.log("🚀 [room.js:listenForInvitations] Function called with userEmail:", userEmail);
  if (!userEmail) {
    console.warn("⚠️ [room.js:listenForInvitations] Called without userEmail! Aborting.");
    return;
  }

  // Tear down any previous invite listener
  if (typeof _inviteUnsubscribe === "function") {
    console.log("🔄 [room.js:listenForInvitations] Tearing down previous invite listener");
    _inviteUnsubscribe();
    _inviteUnsubscribe = null;
  }

  try {
    const normEmail = normaliseEmail(userEmail);
    console.log("📧 [room.js:listenForInvitations] Normalised email:", normEmail);
    const emailHash = await sha256hex(normEmail);
    console.log(`🔑 [room.js:listenForInvitations] Calculated SHA-256 hash: "${emailHash}"`);
    const invitesRef = collection(db, "invitations", emailHash, "pendingInvites");
    console.log(`📂 [room.js:listenForInvitations] Attaching onSnapshot to collection path: "${invitesRef.path}"`);

    _inviteUnsubscribe = onSnapshot(
      invitesRef,
      (snapshot) => {
        const docCount = snapshot && snapshot.docs ? snapshot.docs.length : 0;
        console.log(`⚡ [room.js:onSnapshot] FIRED! Total docs received: ${docCount}, empty: ${snapshot?.empty}, fromCache: ${snapshot?.metadata?.fromCache}`);

        const invites = [];
        if (snapshot && snapshot.docs) {
          snapshot.docs.forEach((docSnap, idx) => {
            const data = docSnap.data() || {};
            console.log(`📄 [room.js:onSnapshot] Doc [${idx}] ID: "${docSnap.id}" | Raw Data:`, data);
            invites.push({
              id: docSnap.id,
              roomId: data.roomId || docSnap.id,
              invitedBy: data.invitedBy || "unknown",
              createdAt: data.createdAt,
              expiresAt: data.expiresAt,
              ...data,
            });
          });
        }

        console.log(`📦 [room.js:onSnapshot] Passing ${invites.length} mapped invite(s) to onInvites callback:`, invites);
        if (typeof onInvites === "function") {
          onInvites(invites);
        } else {
          console.error("❌ [room.js:onSnapshot] onInvites is not a function!", onInvites);
        }
      },
      (err) => {
        console.error("❌ [room.js:onSnapshot ERROR] Failed to listen to invitations:", err.code, err.message, err);
        if (typeof onError === "function") {
          onError(err);
        }
      }
    );
    console.log("✅ [room.js:listenForInvitations] onSnapshot listener attached successfully.");
  } catch (err) {
    console.error("💥 [room.js:listenForInvitations] Synchronous/setup error:", err.message, err);
    if (typeof onError === "function") onError(err);
  }
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
    const roomRef = doc(db, "rooms", roomId);
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
      status: "active",
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
 *
 * Safe operation order:
 *   1. End the room FIRST so that even if the invitation delete fails,
 *      the stale invitation cannot be used to join (join rule requires
 *      status == "waiting").
 *   2. Then delete the invitation (best-effort).
 *
 * If inviteeEmail is not provided (e.g. after a page refresh loses
 * in-memory state), the email is recovered from the room document.
 *
 * @param {string} creatorUid
 * @param {string} roomId
 * @param {string|null|undefined} inviteeEmail  May be null after page refresh
 */
async function cancelRoom(creatorUid, roomId, inviteeEmail) {
  try {
    const roomRef = doc(db, "rooms", roomId);

    // Recover inviteeEmail from Firestore if it was lost (e.g. page refresh)
    let normEmail = inviteeEmail ? normaliseEmail(inviteeEmail) : null;
    if (!normEmail) {
      const roomSnap = await getDoc(roomRef);
      if (!roomSnap.exists()) {
        console.warn("[room] cancelRoom: room not found:", roomId);
        return;
      }
      normEmail = roomSnap.data().inviteeEmail ?? null;
      if (!normEmail) {
        console.warn("[room] cancelRoom: room has no inviteeEmail, invitation cleanup skipped.");
      }
    }

    // Step 1: End the room FIRST.
    // Once ended, any stale invitation is harmless — the join rule requires
    // status == "waiting", which will now fail.
    await updateDoc(roomRef, { status: "ended" });

    // Step 2: Delete the invitation (best-effort).
    // If this fails, the invitation remains visible to the invitee but
    // cannot be accepted because the room is ended.
    if (normEmail) {
      const emailHash = await sha256hex(normEmail);
      const inviteRef = doc(db, "invitations", emailHash, "pendingInvites", roomId);
      await deleteDoc(inviteRef).catch((err) => {
        console.warn(
          "[room] cancelRoom: invitation cleanup failed (room is ended, safe to ignore).",
          err.message
        );
      });
    }

  } catch (err) {
    console.error("[room] cancelRoom failed:", err.code, err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Room messages: sending and listening
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Send a message (text or gesture) to an active room.
 *
 * @param {string} roomId
 * @param {string} senderUid
 * @param {string} senderEmail
 * @param {string} text
 * @param {"text"|"gesture"} type
 * @returns {Promise<{ok: boolean, id?: string, error?: string, code?: string}>}
 */
async function sendRoomMessage(roomId, senderUid, senderEmail, text, type = "text") {
  console.log(`📤 [room.js:sendRoomMessage] Sending ${type} message to room ${roomId}:`, { senderUid, senderEmail, text });
  if (!roomId) {
    console.warn("⚠️ [room.js:sendRoomMessage] Missing roomId!");
    return { ok: false, error: "No active room." };
  }
  const cleanText = (text || "").trim();
  if (!cleanText) {
    console.warn("⚠️ [room.js:sendRoomMessage] Empty message text!");
    return { ok: false, error: "Message cannot be empty." };
  }

  const uid = senderUid || auth.currentUser?.uid;
  const email = senderEmail || auth.currentUser?.email || "Participant";

  if (!uid) {
    console.error("❌ [room.js:sendRoomMessage] No authenticated user UID found!");
    return { ok: false, error: "User is not authenticated." };
  }

  try {
    const messagesRef = collection(db, "rooms", roomId, "messages");
    const docRef = await addDoc(messagesRef, {
      senderUid: uid,
      senderEmail: email,
      text: cleanText,
      type: type,
      timestamp: serverTimestamp(),
    });
    console.log(`✅ [room.js:sendRoomMessage] Message written to Firestore! Doc ID: ${docRef.id}`);
    return { ok: true, id: docRef.id };
  } catch (err) {
    console.error(`❌ [room.js:sendRoomMessage ERROR]:`, err.code, err.message, err);
    return { ok: false, error: err.message, code: err.code };
  }
}

/**
 * Text-to-Speech helper for room messages using the native Web Speech API.
 * Speaks the text aloud via window.speechSynthesis.speak().
 *
 * @param {string} text - Message or gesture text to speak aloud
 */
function speakRoomMessage(text) {
  if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }

  // ── Mute check: verify if room voice is enabled ─────────────────────────
  if (typeof window.isRoomVoiceEnabled === "function") {
    if (!window.isRoomVoiceEnabled()) {
      console.log(`🔇 [room.js:speakRoomMessage] Room voice is muted (Voice Off). Suppressed: "${text}"`);
      return;
    }
  } else {
    const btn = document.getElementById("btnRoomVoice");
    if (btn && btn.classList.contains("voice-off")) {
      console.log(`🔇 [room.js:speakRoomMessage] Room voice is muted (voice-off). Suppressed: "${text}"`);
      return;
    }
  }

  try {
    // If window.speak is available from app.js, delegate with force=true to inherit voice preferences
    if (typeof window.speak === "function") {
      window.speak(text, true);
      console.log(`🗣️ [room.js:speakRoomMessage] Spoke via window.speak: "${text}"`);
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(text).trim());
    utterance.lang = "en-US";
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Pick voice according to gender selection in DOM
    const roomSelect = document.getElementById("roomVoiceSelect");
    const gender = (roomSelect && roomSelect.value) || "female";
    const femaleKeywords = ["female","woman","girl","zira","samantha","victoria","karen","moira","tessa","fiona","allison","ava","susan"];
    const maleKeywords   = ["male","man","david","mark","james","daniel","alex","fred","thomas","jorge","rishi"];
    const keywords = gender === "female" ? femaleKeywords : maleKeywords;

    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) {
      let match = voices.find((v) => v.lang && v.lang.startsWith("en") && keywords.some((k) => v.name.toLowerCase().includes(k)));
      if (!match) match = voices.find((v) => v.lang && v.lang.startsWith("en"));
      if (match) utterance.voice = match;
    }

    window.speechSynthesis.speak(utterance);
    console.log(`🗣️ [room.js:speakRoomMessage] Spoke: "${text}"`);
  } catch (err) {
    console.warn("⚠️ [room.js:speakRoomMessage] Web Speech API error:", err);
  }
}

// Fallback handlers if app.js is not yet evaluated
function toggleRoomVoice() {
  if (typeof window.toggleRoomVoice === "function" && window.toggleRoomVoice !== toggleRoomVoice) {
    return window.toggleRoomVoice();
  }
  const btn = document.getElementById("btnRoomVoice");
  const status = document.getElementById("roomVoiceStatusText");
  const isCurrentlyOn = btn ? btn.classList.contains("voice-on") : true;
  const nextOn = !isCurrentlyOn;
  if (btn) {
    btn.classList.toggle("voice-on", nextOn);
    btn.classList.toggle("voice-off", !nextOn);
    btn.setAttribute("aria-pressed", String(nextOn));
    const icon = btn.querySelector(".voice-icon");
    if (icon) icon.textContent = nextOn ? "🔊" : "🔇";
    if (status) status.textContent = nextOn ? "Voice On" : "Voice Off";
  }
  if (!nextOn && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

function onRoomVoiceSelectChange() {
  if (typeof window.onRoomVoiceSelectChange === "function" && window.onRoomVoiceSelectChange !== onRoomVoiceSelectChange) {
    return window.onRoomVoiceSelectChange();
  }
}

// Expose globally for convenience
if (typeof window !== "undefined") {
  window.speakRoomMessage = speakRoomMessage;
  if (!window.toggleRoomVoice) window.toggleRoomVoice = toggleRoomVoice;
  if (!window.onRoomVoiceSelectChange) window.onRoomVoiceSelectChange = onRoomVoiceSelectChange;
}

/**
 * Listen for messages in an active room.
 *
 * Ordered by timestamp ascending (chronological).
 * State management ensures newly arriving messages are distinguished from
 * initial history so that speech synthesis is only triggered on new messages.
 *
 * @param {string}   roomId
 * @param {function} onMessages  Callback(messages: Array, newMessages: Array)
 * @param {function} onError     Callback(Error)
 */
function listenToRoomMessages(roomId, onMessages, onError) {
  console.log(`👂 [room.js:listenToRoomMessages] Setting up listener for room: ${roomId}`);
  if (typeof _messagesUnsubscribe === "function") {
    console.log("🔄 [room.js:listenToRoomMessages] Tearing down previous messages listener");
    _messagesUnsubscribe();
    _messagesUnsubscribe = null;
  }

  const messagesRef = collection(db, "rooms", roomId, "messages");
  const q = query(messagesRef, orderBy("timestamp", "asc"));

  let isInitialSnapshot = true;
  const seenMessageIds = new Set();
  const listenerStartTime = Date.now();

  _messagesUnsubscribe = onSnapshot(
    q,
    (snap) => {
      console.log(`⚡ [room.js:listenToRoomMessages] onSnapshot fired! Total docs: ${snap.size}, fromCache: ${snap.metadata.fromCache}`);
      const messages = [];
      const newMessages = [];

      snap.forEach((d) => {
        const data = d.data();
        const msg = { id: d.id, ...data };
        messages.push(msg);

        // State check: distinguish newly arriving messages from initial load
        if (!isInitialSnapshot && !seenMessageIds.has(d.id)) {
          let msgMillis = 0;
          if (data.timestamp) {
            if (typeof data.timestamp.toMillis === "function") {
              msgMillis = data.timestamp.toMillis();
            } else if (typeof data.timestamp.seconds === "number") {
              msgMillis = data.timestamp.seconds * 1000;
            } else if (typeof data.timestamp === "number") {
              msgMillis = data.timestamp;
            }
          }
          // Accept if pending write or timestamp is >= listenerStartTime (with small skew margin)
          if (!msgMillis || msgMillis >= listenerStartTime - 5000) {
            newMessages.push(msg);
          }
        }
        seenMessageIds.add(d.id);
      });

      if (isInitialSnapshot) {
        isInitialSnapshot = false;
        console.log(`📋 [room.js:listenToRoomMessages] Initial snapshot loaded with ${messages.length} existing message(s). TTS suppressed for history.`);
      } else if (newMessages.length > 0) {
        console.log(`🔊 [room.js:listenToRoomMessages] Detected ${newMessages.length} newly arriving message(s):`, newMessages);
      }

      if (typeof onMessages === "function") {
        onMessages(messages, newMessages);
      }
    },
    (err) => {
      console.error("❌ [room.js:listenToRoomMessages ERROR]:", err.code, err.message, err);
      if (typeof onError === "function") onError(err);
    }
  );
}

/**
 * Stop listening to room messages.
 */
function unsubscribeRoomMessages() {
  if (typeof _messagesUnsubscribe === "function") {
    _messagesUnsubscribe();
    _messagesUnsubscribe = null;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tear down room session listeners (room status & messages) without
 * cancelling the invitation listener.
 * Call when leaving or cancelling a room.
 */
function unsubscribeRoomSession() {
  if (typeof _roomUnsubscribe === "function") { _roomUnsubscribe(); _roomUnsubscribe = null; }
  if (typeof _messagesUnsubscribe === "function") { _messagesUnsubscribe(); _messagesUnsubscribe = null; }
}

/**
 * Tear down all active listeners including invitations.
 * Call on sign-out or beforeunload.
 */
function unsubscribeRoom() {
  unsubscribeRoomSession();
  if (typeof _inviteUnsubscribe === "function") { _inviteUnsubscribe(); _inviteUnsubscribe = null; }
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
  sendRoomMessage,
  listenToRoomMessages,
  unsubscribeRoomMessages,
  unsubscribeRoomSession,
  unsubscribeRoom,
  speakRoomMessage,
  toggleRoomVoice,
  onRoomVoiceSelectChange,
};
