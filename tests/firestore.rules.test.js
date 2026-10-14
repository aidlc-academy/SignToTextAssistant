/**
 * firestore.rules.test.js
 * -----------------------
 * Automated tests for Firestore Security Rules.
 *
 * Stack (exact installed versions):
 *   @firebase/rules-unit-testing  6.0.0   (CJS, require())
 *   firebase                      13.0.0
 *   mocha                         12.0.3
 *   Node.js                       24 (built-in crypto for SHA-256)
 *
 * package.json "type": "commonjs" — require() is used throughout.
 *
 * These tests have NOT passed yet. They must be run against the
 * Firestore Emulator to produce a result.
 *
 * Run order:
 *   1. Start emulator:  firebase emulators:start --only firestore
 *   2. In a new terminal: npm test
 */

"use strict";

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");   // Node.js built-in — no install needed

const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require("@firebase/rules-unit-testing");

const {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, Timestamp,
} = require("firebase/firestore");

// ── Configuration ─────────────────────────────────────────────────────────

const PROJECT_ID     = "demo-signtotextassistant";
const FIRESTORE_HOST = "127.0.0.1";
const FIRESTORE_PORT = 8080;

// Requirement 1: path relative to THIS file, not the terminal cwd.
// __dirname is the tests/ folder; rules are one level up.
const RULES_PATH = path.resolve(__dirname, "../firestore.rules");

// ── Test users ────────────────────────────────────────────────────────────

const CREATOR_UID   = "uid-creator-001";
const CREATOR_EMAIL = "creator@example.com";

const INVITEE_UID   = "uid-invitee-002";
const INVITEE_EMAIL = "invitee@example.com";

const OTHER_UID   = "uid-other-003";
const OTHER_EMAIL = "other@example.com";

// ── SHA-256 helper (mirrors sha256hex() in static/room.js) ────────────────
// room.js normalises email to lowercase then calls .toUpperCase() on the hex.
// hashing.sha256(email.lower()).toHexString() in Firestore Rules also returns
// uppercase hex. Both sides must agree on the same hash string.
function sha256upper(email) {
  return crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .toUpperCase();
}

const INVITEE_HASH = sha256upper(INVITEE_EMAIL);  // path segment for invitee
const OTHER_HASH   = sha256upper(OTHER_EMAIL);    // path segment for other user

// ── Data builders — match room.js schema exactly ─────────────────────────

/**
 * Build a valid room document as room.js createRoom() writes it.
 * Fields: createdBy, participants, inviteeEmail, status, createdAt
 */
function makeRoom(creatorUid, inviteeEmail, overrides = {}) {
  return {
    createdBy:    creatorUid,
    participants: [creatorUid],
    inviteeEmail: inviteeEmail.trim().toLowerCase(),
    status:       "waiting",
    createdAt:    Timestamp.now(),
    ...overrides,
  };
}

/**
 * Build a valid invitation document as room.js createRoom() writes it.
 * Fields: roomId, invitedBy, createdAt, expiresAt
 */
function makeInvite(roomId, creatorEmail, overrides = {}) {
  return {
    roomId:    roomId,
    invitedBy: creatorEmail,
    createdAt: Timestamp.now(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

// ── Test environment ──────────────────────────────────────────────────────

let testEnv;

before(async function () {
  this.timeout(20_000);
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(RULES_PATH, "utf8"),
      host:  FIRESTORE_HOST,
      port:  FIRESTORE_PORT,
    },
  });
});

afterEach(async function () {
  this.timeout(10_000);
  await testEnv.clearFirestore();
});

after(async function () {
  this.timeout(10_000);
  await testEnv.cleanup();
});

// ── Helper: get an authenticated Firestore instance ───────────────────────
function db(uid, email) {
  return testEnv.authenticatedContext(uid, { email }).firestore();
}

function anonDb() {
  return testEnv.unauthenticatedContext().firestore();
}

/**
 * Write documents as admin (security rules bypassed).
 * Use this to set up pre-conditions for tests.
 */
async function adminWrite(writes) {
  // writes: array of { path: string[], data: object }
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const adminDb = ctx.firestore();
    for (const w of writes) {
      const ref = doc(adminDb, ...w.path);
      await setDoc(ref, w.data);
    }
  });
}

// Helper: set up a room + invitation as admin
async function setupRoomWithInvite(roomId, roomData, inviteData) {
  await adminWrite([
    { path: ["rooms", roomId], data: roomData },
    {
      path: ["invitations", INVITEE_HASH, "pendingInvites", roomId],
      data: inviteData,
    },
  ]);
}

// Helper: set up a room without an invitation
async function setupRoom(roomId, roomData) {
  await adminWrite([{ path: ["rooms", roomId], data: roomData }]);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. PERSONAL TRANSLATION HISTORY
// Path: users/{userId}/translations/{translationId}
// ═══════════════════════════════════════════════════════════════════════════

describe("Personal translation history", function () {
  const translation = { gesture: "HELLO", timestamp: "2026-10-12T14:00:00", confidence: 0.95 };

  it("owner can write their own translation", async function () {
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "users", CREATOR_UID, "translations", "t1");
    await assertSucceeds(setDoc(ref, translation));
  });

  it("owner can read their own translation", async function () {
    await adminWrite([{ path: ["users", CREATOR_UID, "translations", "t1"], data: translation }]);
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "users", CREATOR_UID, "translations", "t1");
    await assertSucceeds(getDoc(ref));
  });

  it("another authenticated user cannot read owner's translation", async function () {
    await adminWrite([{ path: ["users", CREATOR_UID, "translations", "t1"], data: translation }]);
    const ref = doc(db(OTHER_UID, OTHER_EMAIL), "users", CREATOR_UID, "translations", "t1");
    await assertFails(getDoc(ref));
  });

  it("another authenticated user cannot write to owner's translations", async function () {
    const ref = doc(db(OTHER_UID, OTHER_EMAIL), "users", CREATOR_UID, "translations", "t1");
    await assertFails(setDoc(ref, translation));
  });

  it("unauthenticated user cannot read translations", async function () {
    await adminWrite([{ path: ["users", CREATOR_UID, "translations", "t1"], data: translation }]);
    const ref = doc(anonDb(), "users", CREATOR_UID, "translations", "t1");
    await assertFails(getDoc(ref));
  });

  it("unauthenticated user cannot write translations", async function () {
    const ref = doc(anonDb(), "users", CREATOR_UID, "translations", "t1");
    await assertFails(setDoc(ref, translation));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. ROOM CREATION
// ═══════════════════════════════════════════════════════════════════════════

describe("Room creation", function () {

  it("authenticated creator can create a valid room", async function () {
    const ref = collection(db(CREATOR_UID, CREATOR_EMAIL), "rooms");
    await assertSucceeds(
      addDoc(ref, makeRoom(CREATOR_UID, INVITEE_EMAIL))
    );
  });

  it("unauthenticated user cannot create a room", async function () {
    const ref = collection(anonDb(), "rooms");
    await assertFails(
      addDoc(ref, makeRoom(CREATOR_UID, INVITEE_EMAIL))
    );
  });

  it("creator cannot list themselves as someone else in createdBy", async function () {
    const ref = collection(db(CREATOR_UID, CREATOR_EMAIL), "rooms");
    await assertFails(
      addDoc(ref, makeRoom(CREATOR_UID, INVITEE_EMAIL, { createdBy: OTHER_UID }))
    );
  });

  it("room creation with status 'active' is denied", async function () {
    const ref = collection(db(CREATOR_UID, CREATOR_EMAIL), "rooms");
    await assertFails(
      addDoc(ref, makeRoom(CREATOR_UID, INVITEE_EMAIL, { status: "active" }))
    );
  });

  it("room creation with status 'ended' is denied", async function () {
    const ref = collection(db(CREATOR_UID, CREATOR_EMAIL), "rooms");
    await assertFails(
      addDoc(ref, makeRoom(CREATOR_UID, INVITEE_EMAIL, { status: "ended" }))
    );
  });

  it("room creation with extra fields is denied", async function () {
    const ref = collection(db(CREATOR_UID, CREATOR_EMAIL), "rooms");
    await assertFails(
      addDoc(ref, makeRoom(CREATOR_UID, INVITEE_EMAIL, { extraField: true }))
    );
  });

  it("room creation with two participants from the start is denied", async function () {
    const ref = collection(db(CREATOR_UID, CREATOR_EMAIL), "rooms");
    await assertFails(
      addDoc(ref, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
        participants: [CREATOR_UID, INVITEE_UID],
      }))
    );
  });

  it("self-invite is denied (inviteeEmail == creator email)", async function () {
    const ref = collection(db(CREATOR_UID, CREATOR_EMAIL), "rooms");
    await assertFails(
      addDoc(ref, makeRoom(CREATOR_UID, CREATOR_EMAIL))
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ROOM READS
// ═══════════════════════════════════════════════════════════════════════════

describe("Room reads", function () {
  const ROOM_ID = "room-read-001";

  beforeEach(async function () {
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
  });

  it("creator can read their own waiting room", async function () {
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(getDoc(ref));
  });

  it("invitee can read the room before joining (via invitation gate)", async function () {
    // Invitee holds a valid invitation — callerHasInvitation() allows the read
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(getDoc(ref));
  });

  it("unauthenticated user cannot read a room", async function () {
    const ref = doc(anonDb(), "rooms", ROOM_ID);
    await assertFails(getDoc(ref));
  });

  it("unrelated authenticated user cannot read a room", async function () {
    const ref = doc(db(OTHER_UID, OTHER_EMAIL), "rooms", ROOM_ID);
    await assertFails(getDoc(ref));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. JOINING A ROOM  (waiting → active)
// ═══════════════════════════════════════════════════════════════════════════

describe("Joining a room", function () {

  it("valid invitee can join with a matching invitation", async function () {
    const ROOM_ID = "room-join-valid";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(
      updateDoc(ref, {
        participants: [CREATOR_UID, INVITEE_UID],
        status:       "active",
      })
    );
  });

  it("invitee cannot join without an invitation document", async function () {
    const ROOM_ID = "room-join-noinvite";
    // Room exists but no invitation document written
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertFails(
      updateDoc(ref, {
        participants: [CREATOR_UID, INVITEE_UID],
        status:       "active",
      })
    );
  });

  it("unrelated user cannot join even if they guess the roomId", async function () {
    const ROOM_ID = "room-join-other";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(db(OTHER_UID, OTHER_EMAIL), "rooms", ROOM_ID);
    await assertFails(
      updateDoc(ref, {
        participants: [CREATOR_UID, OTHER_UID],
        status:       "active",
      })
    );
  });

  it("creator cannot join their own room as invitee", async function () {
    const ROOM_ID = "room-join-self";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "rooms", ROOM_ID);
    await assertFails(
      updateDoc(ref, {
        participants: [CREATOR_UID, CREATOR_UID],
        status:       "active",
      })
    );
  });

  it("invitee cannot inject a third participant during join", async function () {
    const ROOM_ID = "room-join-inject";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertFails(
      updateDoc(ref, {
        participants: [CREATOR_UID, INVITEE_UID, OTHER_UID],
        status:       "active",
      })
    );
  });

  it("invitee cannot change createdBy during join", async function () {
    const ROOM_ID = "room-join-mutatecreator";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertFails(
      updateDoc(ref, {
        participants: [CREATOR_UID, INVITEE_UID],
        status:       "active",
        createdBy:    INVITEE_UID,          // must not change
      })
    );
  });

  it("invitee cannot change inviteeEmail during join", async function () {
    const ROOM_ID = "room-join-mutateemail";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertFails(
      updateDoc(ref, {
        participants: [CREATOR_UID, INVITEE_UID],
        status:       "active",
        inviteeEmail: OTHER_EMAIL,          // must not change
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. ENDING A ROOM  (waiting|active → ended)
// ═══════════════════════════════════════════════════════════════════════════

describe("Ending a room", function () {

  it("creator can end a waiting room", async function () {
    const ROOM_ID = "room-end-waiting-creator";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(updateDoc(ref, { status: "ended" }));
  });

  it("creator can end an active room", async function () {
    const ROOM_ID = "room-end-active-creator";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status:       "active",
    }));
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(updateDoc(ref, { status: "ended" }));
  });

  it("invitee can end an active room", async function () {
    const ROOM_ID = "room-end-active-invitee";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status:       "active",
    }));
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(updateDoc(ref, { status: "ended" }));
  });

  it("unrelated user cannot end a room", async function () {
    const ROOM_ID = "room-end-other";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status:       "active",
    }));
    const ref = doc(db(OTHER_UID, OTHER_EMAIL), "rooms", ROOM_ID);
    await assertFails(updateDoc(ref, { status: "ended" }));
  });

  it("ended room cannot be set back to active", async function () {
    const ROOM_ID = "room-reactivate";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status:       "ended",
    }));
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "rooms", ROOM_ID);
    await assertFails(updateDoc(ref, { status: "active" }));
  });

  it("ended room cannot be set back to waiting", async function () {
    const ROOM_ID = "room-reactivate-waiting";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status:       "ended",
    }));
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "rooms", ROOM_ID);
    await assertFails(updateDoc(ref, { status: "waiting" }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. ROOM DELETION
// ═══════════════════════════════════════════════════════════════════════════

describe("Room deletion", function () {
  it("creator cannot delete a room via the client SDK", async function () {
    const ROOM_ID = "room-delete";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "rooms", ROOM_ID);
    await assertFails(deleteDoc(ref));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. INVITATION READS
// ═══════════════════════════════════════════════════════════════════════════

describe("Invitation reads", function () {
  const ROOM_ID = "room-invread";

  beforeEach(async function () {
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
  });

  it("intended invitee can read their invitation", async function () {
    const ref = doc(
      db(INVITEE_UID, INVITEE_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertSucceeds(getDoc(ref));
  });

  it("creator cannot read the invitee's invitation", async function () {
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(getDoc(ref));
  });

  it("unrelated user cannot read the invitee's invitation", async function () {
    const ref = doc(
      db(OTHER_UID, OTHER_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(getDoc(ref));
  });

  it("unauthenticated user cannot read any invitation", async function () {
    const ref = doc(
      anonDb(),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(getDoc(ref));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. INVITATION CREATION
// ═══════════════════════════════════════════════════════════════════════════

describe("Invitation creation", function () {

  it("room creator can create a valid invitation", async function () {
    const ROOM_ID = "room-invcreate-valid";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertSucceeds(setDoc(ref, makeInvite(ROOM_ID, CREATOR_EMAIL)));
  });

  it("non-creator cannot create an invitation for someone else's room", async function () {
    const ROOM_ID = "room-invcreate-noncreator";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(
      db(OTHER_UID, OTHER_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(setDoc(ref, makeInvite(ROOM_ID, OTHER_EMAIL)));
  });

  it("invitation for a non-existent room is denied", async function () {
    // No room document written — just try to create the invitation
    const FAKE_ROOM_ID = "room-does-not-exist";
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", FAKE_ROOM_ID
    );
    await assertFails(setDoc(ref, makeInvite(FAKE_ROOM_ID, CREATOR_EMAIL)));
  });

  it("invitation at wrong email hash is denied", async function () {
    // Room expects INVITEE_EMAIL but invitation is written at OTHER_HASH
    const ROOM_ID = "room-invcreate-wronghash";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", OTHER_HASH, "pendingInvites", ROOM_ID  // wrong hash
    );
    await assertFails(setDoc(ref, makeInvite(ROOM_ID, CREATOR_EMAIL)));
  });

  it("invitation with mismatched roomId field is denied", async function () {
    const ROOM_ID = "room-invcreate-badfield";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    // roomId field inside the doc does not match the doc ID (ROOM_ID)
    await assertFails(
      setDoc(ref, makeInvite(ROOM_ID, CREATOR_EMAIL, { roomId: "some-other-id" }))
    );
  });

  it("invitation with extra fields is denied", async function () {
    const ROOM_ID = "room-invcreate-extrafields";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(
      setDoc(ref, makeInvite(ROOM_ID, CREATOR_EMAIL, { malicious: "data" }))
    );
  });

  it("invitation for an already-active room is denied", async function () {
    const ROOM_ID = "room-invcreate-active";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status:       "active",
    }));
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(setDoc(ref, makeInvite(ROOM_ID, CREATOR_EMAIL)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. INVITATION UPDATES (always denied)
// ═══════════════════════════════════════════════════════════════════════════

describe("Invitation updates", function () {
  it("invitee cannot update their own invitation", async function () {
    const ROOM_ID = "room-invupdate";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(
      db(INVITEE_UID, INVITEE_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(updateDoc(ref, { invitedBy: "hacked" }));
  });

  it("creator cannot update an invitation", async function () {
    const ROOM_ID = "room-invupdate-creator";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(updateDoc(ref, { invitedBy: "hacked" }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. INVITATION DELETION
// ═══════════════════════════════════════════════════════════════════════════

describe("Invitation deletion", function () {

  it("invitee can delete their own invitation (accept/decline)", async function () {
    const ROOM_ID = "room-invdelete-invitee";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(
      db(INVITEE_UID, INVITEE_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertSucceeds(deleteDoc(ref));
  });

  it("room creator can delete the invitation (cancel room)", async function () {
    const ROOM_ID = "room-invdelete-creator";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertSucceeds(deleteDoc(ref));
  });

  it("unrelated user cannot delete an invitation", async function () {
    const ROOM_ID = "room-invdelete-other";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(
      db(OTHER_UID, OTHER_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(deleteDoc(ref));
  });

  it("unauthenticated user cannot delete an invitation", async function () {
    const ROOM_ID = "room-invdelete-anon";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(
      anonDb(),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(deleteDoc(ref));
  });
});
