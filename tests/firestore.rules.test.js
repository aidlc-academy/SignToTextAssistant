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
 * expiresAt is a Firestore Timestamp (changed from ISO string) so the
 * rules can enforce expiry with request.time < resource.data.expiresAt.
 */
function makeInvite(roomId, creatorEmail, overrides = {}) {
  return {
    roomId:    roomId,
    invitedBy: creatorEmail,
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 86_400_000)),
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

// ═══════════════════════════════════════════════════════════════════════════
// 11. INVITATION EXPIRY
// ═══════════════════════════════════════════════════════════════════════════

describe("Invitation expiry", function () {

  it("invitee can read a non-expired invitation", async function () {
    const ROOM_ID = "room-expiry-valid";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(
      db(INVITEE_UID, INVITEE_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertSucceeds(getDoc(ref));
  });

  it("invitee cannot read an expired invitation", async function () {
    const ROOM_ID = "room-expiry-expired-read";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL, {
        expiresAt: Timestamp.fromDate(new Date(Date.now() - 2_000)),
      })
    );
    const ref = doc(
      db(INVITEE_UID, INVITEE_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(getDoc(ref));
  });

  it("expired invitation cannot be used to join a room", async function () {
    const ROOM_ID = "room-expiry-expired-join";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_ID, CREATOR_EMAIL, {
        expiresAt: Timestamp.fromDate(new Date(Date.now() - 2_000)),
      })
    );
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertFails(
      updateDoc(ref, {
        participants: [CREATOR_UID, INVITEE_UID],
        status:       "active",
      })
    );
  });

  it("creator cannot create an invitation with expiresAt in the past", async function () {
    const ROOM_ID = "room-expiry-past-create";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(
      setDoc(ref, makeInvite(ROOM_ID, CREATOR_EMAIL, {
        expiresAt: Timestamp.fromDate(new Date(Date.now() - 1_000)),
      }))
    );
  });

  it("creator cannot create an invitation expiring more than 24 hours from now", async function () {
    const ROOM_ID = "room-expiry-toolong";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(
      setDoc(ref, makeInvite(ROOM_ID, CREATOR_EMAIL, {
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 25 * 60 * 60 * 1000)),
      }))
    );
  });

  it("invitation with expiresAt as a string is denied (wrong type)", async function () {
    const ROOM_ID = "room-expiry-string-type";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertFails(
      setDoc(ref, makeInvite(ROOM_ID, CREATOR_EMAIL, {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }))
    );
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// 12. ACTIVE AND ENDED ROOM READS
// ═══════════════════════════════════════════════════════════════════════════

describe("Active and ended room reads", function () {

  it("creator can read an active room", async function () {
    const ROOM_ID = "room-active-read-creator";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status: "active",
    }));
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(getDoc(ref));
  });

  it("invitee can read an active room as participant", async function () {
    const ROOM_ID = "room-active-read-invitee";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status: "active",
    }));
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(getDoc(ref));
  });

  it("unrelated user cannot read an active room", async function () {
    const ROOM_ID = "room-active-read-other";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status: "active",
    }));
    const ref = doc(db(OTHER_UID, OTHER_EMAIL), "rooms", ROOM_ID);
    await assertFails(getDoc(ref));
  });

  it("creator can read an ended room", async function () {
    const ROOM_ID = "room-ended-read-creator";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status: "ended",
    }));
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(getDoc(ref));
  });

  it("invitee can read an ended room as participant", async function () {
    const ROOM_ID = "room-ended-read-invitee";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL, {
      participants: [CREATOR_UID, INVITEE_UID],
      status: "ended",
    }));
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(getDoc(ref));
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// 13. CROSS-ROOM INVITATION REUSE
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-room invitation reuse", function () {

  it("invitee with invitation for Room A cannot join Room B", async function () {
    const ROOM_A = "room-cross-a";
    const ROOM_B = "room-cross-b";
    // Room A: valid invitation for invitee
    await setupRoomWithInvite(
      ROOM_A,
      makeRoom(CREATOR_UID, INVITEE_EMAIL),
      makeInvite(ROOM_A, CREATOR_EMAIL)
    );
    // Room B: no invitation, but same inviteeEmail
    await setupRoom(ROOM_B, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    // Invitee tries to join Room B — callerHasInvitation() checks pendingInvites/ROOM_B
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_B);
    await assertFails(
      updateDoc(ref, {
        participants: [CREATOR_UID, INVITEE_UID],
        status:       "active",
      })
    );
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// 14. JOINING A ROOM WITH AN ENDED ROOM
// ═══════════════════════════════════════════════════════════════════════════

describe("Joining an ended room", function () {

  it("invitee cannot join a room that is already ended", async function () {
    const ROOM_ID = "room-join-ended";
    // Room is ended (e.g. creator cancelled before invitee accepted)
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL, { status: "ended" }),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const ref = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertFails(
      updateDoc(ref, {
        participants: [CREATOR_UID, INVITEE_UID],
        status:       "active",
      })
    );
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// 15. CANCELLATION AFTER REFRESH (rules-side: ended room operations)
// ═══════════════════════════════════════════════════════════════════════════
// Note: the full cancelRoom() refresh-recovery path runs inside room.js and
// uses getDoc + updateDoc + deleteDoc in sequence. The rules-side behaviour
// tested here is: a creator who recovers inviteeEmail from Firestore can still
// end a waiting room and delete its invitation — i.e., the rules allow these
// operations regardless of whether the creator's in-memory state was lost.

describe("Cancellation after refresh (rules perspective)", function () {

  it("creator can end a waiting room (simulates cancelRoom step 1)", async function () {
    const ROOM_ID = "room-refresh-cancel-end";
    await setupRoom(ROOM_ID, makeRoom(CREATOR_UID, INVITEE_EMAIL));
    const ref = doc(db(CREATOR_UID, CREATOR_EMAIL), "rooms", ROOM_ID);
    await assertSucceeds(updateDoc(ref, { status: "ended" }));
  });

  it("creator can delete invitation after ending room (simulates cancelRoom step 2)", async function () {
    const ROOM_ID = "room-refresh-cancel-invite";
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL, { status: "ended" }),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const invRef = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "invitations", INVITEE_HASH, "pendingInvites", ROOM_ID
    );
    await assertSucceeds(deleteDoc(invRef));
  });

  it("stale invitation on an ended room cannot be accepted", async function () {
    const ROOM_ID = "room-refresh-stale-invite";
    // Room is ended; invitation still exists (cleanup failed)
    await setupRoomWithInvite(
      ROOM_ID,
      makeRoom(CREATOR_UID, INVITEE_EMAIL, { status: "ended" }),
      makeInvite(ROOM_ID, CREATOR_EMAIL)
    );
    const roomRef = doc(db(INVITEE_UID, INVITEE_EMAIL), "rooms", ROOM_ID);
    await assertFails(
      updateDoc(roomRef, {
        participants: [CREATOR_UID, INVITEE_UID],
        status:       "active",
      })
    );
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// 16. ROOM MESSAGES — rooms/{roomId}/messages/{messageId}
// ═══════════════════════════════════════════════════════════════════════════

describe("Room messages", function () {

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Build a valid message document with the confirmed five-field schema. */
  function makeMessage(senderUid, senderEmail, overrides = {}) {
    return {
      senderUid:   senderUid,
      senderEmail: senderEmail,
      text:        "HELLO",
      type:        "gesture",
      timestamp:   Timestamp.now(),
      ...overrides,
    };
  }

  /** Write an active room (both participants joined) as admin. */
  async function setupActiveRoom(roomId) {
    await adminWrite([{
      path: ["rooms", roomId],
      data: makeRoom(CREATOR_UID, INVITEE_EMAIL, {
        participants: [CREATOR_UID, INVITEE_UID],
        status:       "active",
      }),
    }]);
  }

  // ── Valid message creation ──────────────────────────────────────────────

  it("creator (participant) can send a gesture message", async function () {
    const ROOM_ID = "msg-create-creator-gesture";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_ID, "messages", "m1"
    );
    await assertSucceeds(
      setDoc(ref, makeMessage(CREATOR_UID, CREATOR_EMAIL))
    );
  });

  it("invitee (participant) can send a text reply message", async function () {
    const ROOM_ID = "msg-create-invitee-text";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(
      db(INVITEE_UID, INVITEE_EMAIL),
      "rooms", ROOM_ID, "messages", "m2"
    );
    await assertSucceeds(
      setDoc(ref, makeMessage(INVITEE_UID, INVITEE_EMAIL, {
        text: "Hello back!",
        type: "text",
      }))
    );
  });

  // ── Non-participant access ──────────────────────────────────────────────

  it("non-participant cannot send a message", async function () {
    const ROOM_ID = "msg-create-other";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(
      db(OTHER_UID, OTHER_EMAIL),
      "rooms", ROOM_ID, "messages", "m3"
    );
    await assertFails(
      setDoc(ref, makeMessage(OTHER_UID, OTHER_EMAIL))
    );
  });

  it("unauthenticated user cannot send a message", async function () {
    const ROOM_ID = "msg-create-anon";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(anonDb(), "rooms", ROOM_ID, "messages", "m4");
    await assertFails(
      setDoc(ref, makeMessage(CREATOR_UID, CREATOR_EMAIL))
    );
  });

  // ── senderUid identity enforcement ─────────────────────────────────────

  it("participant cannot send a message with another user's senderUid", async function () {
    const ROOM_ID = "msg-create-wronguid";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_ID, "messages", "m5"
    );
    await assertFails(
      setDoc(ref, makeMessage(INVITEE_UID, INVITEE_EMAIL))  // senderUid != callerUid
    );
  });

  // ── Field validation ────────────────────────────────────────────────────

  it("message with extra field is denied", async function () {
    const ROOM_ID = "msg-extra-field";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_ID, "messages", "m6"
    );
    await assertFails(
      setDoc(ref, makeMessage(CREATOR_UID, CREATOR_EMAIL, { extra: true }))
    );
  });

  it("message missing a required field is denied", async function () {
    const ROOM_ID = "msg-missing-field";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_ID, "messages", "m7"
    );
    // Omit 'type'
    await assertFails(
      setDoc(ref, {
        senderUid:   CREATOR_UID,
        senderEmail: CREATOR_EMAIL,
        text:        "HELLO",
        timestamp:   Timestamp.now(),
      })
    );
  });

  it("message with invalid type value is denied", async function () {
    const ROOM_ID = "msg-bad-type";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_ID, "messages", "m8"
    );
    await assertFails(
      setDoc(ref, makeMessage(CREATOR_UID, CREATOR_EMAIL, { type: "video" }))
    );
  });

  it("message with empty text is denied", async function () {
    const ROOM_ID = "msg-empty-text";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_ID, "messages", "m9"
    );
    await assertFails(
      setDoc(ref, makeMessage(CREATOR_UID, CREATOR_EMAIL, { text: "" }))
    );
  });

  it("message exceeding 500 characters is denied", async function () {
    const ROOM_ID = "msg-too-long";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_ID, "messages", "m10"
    );
    await assertFails(
      setDoc(ref, makeMessage(CREATOR_UID, CREATOR_EMAIL, { text: "x".repeat(501) }))
    );
  });

  it("message with timestamp as string is denied", async function () {
    const ROOM_ID = "msg-bad-timestamp";
    await setupActiveRoom(ROOM_ID);
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_ID, "messages", "m11"
    );
    await assertFails(
      setDoc(ref, makeMessage(CREATOR_UID, CREATOR_EMAIL, {
        timestamp: new Date().toISOString(),  // string, not Timestamp
      }))
    );
  });

  // ── Read access ─────────────────────────────────────────────────────────

  it("participant can read messages in their room", async function () {
    const ROOM_ID = "msg-read-participant";
    await setupActiveRoom(ROOM_ID);
    // Write a message as admin, then read as participant
    await adminWrite([{
      path: ["rooms", ROOM_ID, "messages", "m12"],
      data: makeMessage(CREATOR_UID, CREATOR_EMAIL),
    }]);
    const ref = doc(
      db(INVITEE_UID, INVITEE_EMAIL),
      "rooms", ROOM_ID, "messages", "m12"
    );
    await assertSucceeds(getDoc(ref));
  });

  it("non-participant cannot read messages", async function () {
    const ROOM_ID = "msg-read-other";
    await setupActiveRoom(ROOM_ID);
    await adminWrite([{
      path: ["rooms", ROOM_ID, "messages", "m13"],
      data: makeMessage(CREATOR_UID, CREATOR_EMAIL),
    }]);
    const ref = doc(
      db(OTHER_UID, OTHER_EMAIL),
      "rooms", ROOM_ID, "messages", "m13"
    );
    await assertFails(getDoc(ref));
  });

  // ── Cross-room isolation ────────────────────────────────────────────────

  it("participant of Room A cannot read messages in Room B", async function () {
    const ROOM_A = "msg-cross-room-a";
    const ROOM_B = "msg-cross-room-b";

    // CREATOR + INVITEE are in Room A
    await setupActiveRoom(ROOM_A);

    // Room B has OTHER_UID as creator; CREATOR_UID is not a participant
    await adminWrite([{
      path: ["rooms", ROOM_B],
      data: makeRoom(OTHER_UID, INVITEE_EMAIL, {
        participants: [OTHER_UID],
        status:       "waiting",
      }),
    }, {
      path: ["rooms", ROOM_B, "messages", "m14"],
      data: makeMessage(OTHER_UID, OTHER_EMAIL),
    }]);

    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_B, "messages", "m14"
    );
    await assertFails(getDoc(ref));
  });

  // ── Immutability ────────────────────────────────────────────────────────

  it("participant cannot update a sent message", async function () {
    const ROOM_ID = "msg-update-denied";
    await setupActiveRoom(ROOM_ID);
    await adminWrite([{
      path: ["rooms", ROOM_ID, "messages", "m15"],
      data: makeMessage(CREATOR_UID, CREATOR_EMAIL),
    }]);
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_ID, "messages", "m15"
    );
    await assertFails(updateDoc(ref, { text: "modified" }));
  });

  it("participant cannot delete a sent message", async function () {
    const ROOM_ID = "msg-delete-denied";
    await setupActiveRoom(ROOM_ID);
    await adminWrite([{
      path: ["rooms", ROOM_ID, "messages", "m16"],
      data: makeMessage(CREATOR_UID, CREATOR_EMAIL),
    }]);
    const ref = doc(
      db(CREATOR_UID, CREATOR_EMAIL),
      "rooms", ROOM_ID, "messages", "m16"
    );
    await assertFails(deleteDoc(ref));
  });

});
