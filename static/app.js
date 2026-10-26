/**
 * app.js
 * ------
 * Controls the Sign-to-Text web interface.
 *
 * Sections
 * ────────
 * 1. DOM references
 * 2. Application state
 * 3. Text-to-Speech (Web Speech API)
 * 4. Live gesture label
 * 5. Translation history — Firestore-driven (Phase 2)
 *      - renderHistory(rows)   full re-render with WhatsApp-style date groups
 *      - buildDateSeparator()  date heading element
 *      - buildBubble()         single translation bubble
 *      - clearHistory()        deletes from Firestore only (not SQLite)
 * 6. SQLite polling — gesture detection only (no rendering)
 *      - pollSqliteForNewGestures()  detects new rows, mirrors to Firestore
 * 7. Camera controls
 * 8. Initialisation
 *
 * History source change (Phase 2)
 * ────────────────────────────────
 * History is now read exclusively from each user's Firestore sub-collection
 * via onSnapshot (started by index.html after auth confirms).  The shared
 * SQLite /history endpoint is no longer used to populate the chat panel.
 * SQLite polling continues only to detect newly saved gestures so they can
 * be mirrored to Firestore.
 */

"use strict";

// ═══════════════════════════════════════════════════════════════════════════
// 1. DOM references
// ═══════════════════════════════════════════════════════════════════════════

const videoFeed         = document.getElementById("videoFeed");
const cameraPlaceholder = document.getElementById("cameraPlaceholder");
const btnStart          = document.getElementById("btnStart");
const btnStop           = document.getElementById("btnStop");
const cameraStatus      = document.getElementById("cameraStatus");
const gestureLabel      = document.getElementById("gestureLabel");
const chatBox           = document.getElementById("chatBox");
const emptyState        = document.getElementById("emptyState");
const btnVoice          = document.getElementById("btnVoice");
const voiceStatusText   = document.getElementById("voiceStatusText");
const voiceSelect       = document.getElementById("voiceSelect");
const voiceNote         = document.getElementById("voiceNote");
const btnRoomVoice        = document.getElementById("btnRoomVoice");
const roomVoiceStatusText = document.getElementById("roomVoiceStatusText");
const roomVoiceSelect     = document.getElementById("roomVoiceSelect");

// ═══════════════════════════════════════════════════════════════════════════
// 2. Application state
// ═══════════════════════════════════════════════════════════════════════════

let gesturePollId    = null;   // setInterval id — live gesture label polling
let sqlitePollId     = null;   // setInterval id — SQLite new-gesture detection
let isRunning        = false;  // whether the camera is active
let lastKnownSqliteId = 0;     // highest SQLite row id already mirrored to Firestore

// ═══════════════════════════════════════════════════════════════════════════
// 3. Text-to-Speech  (Web Speech API — runs entirely in the browser)
// ═══════════════════════════════════════════════════════════════════════════

let voiceEnabled     = false;
let roomVoiceEnabled = true;  // Online room incoming speech starts enabled by default
let selectedVoice    = null;
let allVoices        = [];

function loadVoices() {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) { allVoices = voices; pickVoice(); return; }
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    allVoices = window.speechSynthesis.getVoices();
    pickVoice();
  }, { once: true });
  [200, 600, 1400].forEach(delay => {
    setTimeout(() => {
      if (allVoices.length === 0) {
        allVoices = window.speechSynthesis.getVoices();
        if (allVoices.length > 0) pickVoice();
      }
    }, delay);
  });
}

function pickVoice() {
  if (allVoices.length === 0) {
    selectedVoice = null;
    setVoiceNote("No voices found — speech unavailable.");
    return;
  }

  // Synchronize dropdown values between Local Translation and Active Room
  const rSelect = document.getElementById("roomVoiceSelect") || roomVoiceSelect;
  const lSelect = document.getElementById("voiceSelect") || voiceSelect;
  const gender = (rSelect && rSelect.value) || (lSelect && lSelect.value) || "female";

  if (lSelect && lSelect.value !== gender) lSelect.value = gender;
  if (rSelect && rSelect.value !== gender) rSelect.value = gender;

  const femaleKeywords = ["female","woman","girl","zira","samantha","victoria",
                          "karen","moira","tessa","fiona","allison","ava","susan"];
  const maleKeywords   = ["male","man","david","mark","james","daniel",
                          "alex","fred","thomas","jorge","rishi"];
  const keywords = gender === "female" ? femaleKeywords : maleKeywords;

  let match = allVoices.find(v =>
    v.lang.startsWith("en") && keywords.some(k => v.name.toLowerCase().includes(k))
  );
  if (!match) match = allVoices.find(v => v.lang.startsWith("en"));
  if (!match) match = allVoices[0];
  selectedVoice = match;
  setVoiceNote(`Voice: ${match.name} (${match.lang})`);
  console.log(`🔊 [app.js:pickVoice] Selected voice (${gender}): ${match ? match.name : "none"}`);
}

function setVoiceNote(text) {
  if (voiceNote) voiceNote.textContent = text;
}

function speak(text, force = false) {
  if (!force && !voiceEnabled) return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).trim());
  if (selectedVoice) {
    u.voice = selectedVoice;
  } else {
    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) {
      const match = voices.find(v => v.lang && v.lang.startsWith("en"));
      if (match) u.voice = match;
    }
  }
  u.lang     = "en-US";
  u.rate     = 0.95;
  u.pitch    = 1.0;
  u.volume   = 1.0;
  window.speechSynthesis.speak(u);
}

// ── Room Voice Controls & State Sync ─────────────────────────────────────────

function updateRoomVoiceUI() {
  const btn = document.getElementById("btnRoomVoice") || btnRoomVoice;
  const status = document.getElementById("roomVoiceStatusText") || roomVoiceStatusText;
  if (!btn) return;
  if (roomVoiceEnabled) {
    btn.classList.replace("voice-off", "voice-on");
    btn.setAttribute("aria-pressed", "true");
    const icon = btn.querySelector(".voice-icon");
    if (icon) icon.textContent = "🔊";
    if (status) status.textContent = "Voice On";
  } else {
    btn.classList.replace("voice-on", "voice-off");
    btn.setAttribute("aria-pressed", "false");
    const icon = btn.querySelector(".voice-icon");
    if (icon) icon.textContent = "🔇";
    if (status) status.textContent = "Voice Off";
  }
}

function toggleRoomVoice() {
  roomVoiceEnabled = !roomVoiceEnabled;
  updateRoomVoiceUI();
  console.log(`🔊 [app.js:toggleRoomVoice] Room voice is now: ${roomVoiceEnabled ? "ON" : "OFF"}`);
  if (roomVoiceEnabled) {
    loadVoices();
  } else {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }
}

function onRoomVoiceSelectChange() {
  const rSelect = document.getElementById("roomVoiceSelect") || roomVoiceSelect;
  const lSelect = document.getElementById("voiceSelect") || voiceSelect;
  if (rSelect && lSelect) {
    lSelect.value = rSelect.value;
  }
  pickVoice();
}

function toggleVoice() {
  voiceEnabled = !voiceEnabled;
  if (voiceEnabled) {
    btnVoice.classList.replace("voice-off", "voice-on");
    btnVoice.setAttribute("aria-pressed", "true");
    btnVoice.querySelector(".voice-icon").textContent = "🔊";
    voiceStatusText.textContent = "Voice On";
    loadVoices();
  } else {
    btnVoice.classList.replace("voice-on", "voice-off");
    btnVoice.setAttribute("aria-pressed", "false");
    btnVoice.querySelector(".voice-icon").textContent = "🔇";
    voiceStatusText.textContent = "Voice Off";
    setVoiceNote("");
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }
}

function onVoiceSelectChange() {
  const rSelect = document.getElementById("roomVoiceSelect") || roomVoiceSelect;
  const lSelect = document.getElementById("voiceSelect") || voiceSelect;
  if (lSelect && rSelect) {
    rSelect.value = lSelect.value;
  }
  pickVoice();
}

// Expose speech and room voice utilities globally
window.speak = speak;
window.getSelectedVoice = () => selectedVoice;
window.isRoomVoiceEnabled = () => roomVoiceEnabled;
window.setRoomVoiceEnabled = (val) => {
  roomVoiceEnabled = Boolean(val);
  updateRoomVoiceUI();
};
window.toggleVoice = toggleVoice;
window.onVoiceSelectChange = onVoiceSelectChange;
window.toggleRoomVoice = toggleRoomVoice;
window.onRoomVoiceSelectChange = onRoomVoiceSelectChange;
window.updateRoomVoiceUI = updateRoomVoiceUI;

// ═══════════════════════════════════════════════════════════════════════════
// 4. Live gesture label
// ═══════════════════════════════════════════════════════════════════════════

function updateGestureLabel(label) {
  let stateClass;
  if (label === "No Hand Detected")                                   stateClass = "state-none";
  else if (label === "Unknown Gesture")                              stateClass = "state-unknown";
  else if (label === "Waiting…" || label === "Error starting camera") stateClass = "state-idle";
  else                                                                stateClass = "state-known";

  if (gestureLabel && gestureLabel.textContent !== label) {
    gestureLabel.textContent = label;
    gestureLabel.classList.remove("state-idle","state-known","state-unknown","state-none");
    gestureLabel.classList.add(stateClass);
    gestureLabel.classList.remove("pop");
    void gestureLabel.offsetWidth;
    gestureLabel.classList.add("pop");
  }

  const roomGestureLabel = document.getElementById("roomGestureLabel");
  if (roomGestureLabel && roomGestureLabel.textContent !== label) {
    roomGestureLabel.textContent = label;
    roomGestureLabel.classList.remove("state-idle","state-known","state-unknown","state-none");
    roomGestureLabel.classList.add(stateClass);
    roomGestureLabel.classList.remove("pop");
    void roomGestureLabel.offsetWidth;
    roomGestureLabel.classList.add("pop");
  }
}

async function pollGesture() {
  try {
    const res  = await fetch("/gesture");
    if (!res.ok) return;
    const data = await res.json();
    updateGestureLabel(data.gesture);
  } catch { /* silently ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Translation history — Firestore-driven with date grouping
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format an ISO timestamp to a human-readable time string.
 * "2026-10-12T14:35:07" → "2:35:07 PM"
 */
function formatTime(isoString) {
  try {
    const d = new Date(isoString);
    if (isNaN(d)) return isoString;
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  } catch { return isoString; }
}

/**
 * Format an ISO timestamp to a date key string "YYYY-MM-DD".
 * Used to group translations by calendar date.
 */
function toDateKey(isoString) {
  try {
    const d = new Date(isoString);
    if (isNaN(d)) return "unknown";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch { return "unknown"; }
}

/**
 * Format a date key "YYYY-MM-DD" into a human-readable heading.
 * Returns "Today", "Yesterday", or a locale date string.
 */
function formatDateHeading(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const target  = new Date(y, m - 1, d);
  const today   = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate();

  if (sameDay(target, today))     return "Today";
  if (sameDay(target, yesterday)) return "Yesterday";
  return target.toLocaleDateString(undefined, {
    day: "numeric", month: "long", year: "numeric"
  });
}

/**
 * Build a date-separator heading element.
 * @param {string} dateKey  "YYYY-MM-DD"
 */
function buildDateSeparator(dateKey) {
  const sep  = document.createElement("div");
  sep.className        = "date-separator";
  sep.dataset.dateKey  = dateKey;
  const inner          = document.createElement("span");
  inner.className      = "date-separator-label";
  inner.textContent    = formatDateHeading(dateKey);
  sep.appendChild(inner);
  return sep;
}

/**
 * Build a single translation bubble element.
 * @param {{ id:string, gesture:string, timestamp:string }} row
 */
function buildBubble(row) {
  const bubble        = document.createElement("div");
  bubble.className    = "chat-bubble";
  bubble.dataset.id   = row.id;

  const textEl        = document.createElement("span");
  textEl.className    = "bubble-text";
  textEl.textContent  = row.gesture;

  const timeEl        = document.createElement("span");
  timeEl.className    = "bubble-time";
  timeEl.textContent  = formatTime(row.timestamp);

  bubble.appendChild(textEl);
  bubble.appendChild(timeEl);
  return bubble;
}

/**
 * Full re-render of the history panel from a Firestore snapshot.
 *
 * Called every time onSnapshot fires (initial load + every change).
 * Rows arrive newest-first from Firestore (orderBy timestamp desc).
 *
 * Grouping layout (newest at top):
 *
 *   ── Today ──────────────────────
 *   [HELLO]  14:35:07
 *   [YES]    14:33:01
 *   ── 11 October 2026 ─────────────
 *   [STOP]   09:12:44
 *   ...
 *
 * @param {Array<{id, gesture, timestamp, confidence}>} rows  Newest-first
 */
function renderHistory(rows) {
  // Clear existing content (bubbles + separators), but keep the emptyState div
  Array.from(chatBox.children).forEach(child => {
    if (child !== emptyState) child.remove();
  });

  if (rows.length === 0) {
    emptyState.style.display = "";
    return;
  }
  emptyState.style.display = "none";

  // rows is already newest-first; group by date key
  let currentDateKey = null;

  rows.forEach(row => {
    const dateKey = toDateKey(row.timestamp);

    // Insert a new date separator whenever the date changes
    if (dateKey !== currentDateKey) {
      chatBox.appendChild(buildDateSeparator(dateKey));
      currentDateKey = dateKey;
    }

    chatBox.appendChild(buildBubble(row));
  });
}

/**
 * Clear the signed-in user's translation history.
 *
 * Phase 2 change: does NOT call DELETE /history (SQLite).
 * Only the user's own Firestore documents are deleted.
 * The onSnapshot listener will automatically update the UI to show empty.
 */
async function clearHistory() {
  const confirmed = window.confirm(
    "Delete your translation history?\nThis cannot be undone."
  );
  if (!confirmed) return;

  // Prevent double-clicks while the delete is in progress
  const btnClear = document.getElementById("btnClear");
  if (btnClear) btnClear.disabled = true;

  try {
    if (typeof window.firestoreClearHistory === "function") {
      await window.firestoreClearHistory();
      // onSnapshot will fire automatically and call renderHistory([]),
      // which shows the empty state. No manual DOM reset needed here.
    }
  } catch (err) {
    console.error("[app] clearHistory failed:", err);
    alert("Could not clear history. Please try again.");
  } finally {
    if (btnClear) btnClear.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. SQLite polling — gesture detection only, no rendering
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Poll GET /history?after_id=N to detect newly saved gesture rows.
 *
 * These rows are NOT rendered to the chat panel — the Firestore onSnapshot
 * listener handles all rendering.  This function only:
 *   1. Speaks newly detected gestures (TTS).
 *   2. Mirrors them to Firestore via window.firestoreMirror.
 *
 * lastKnownSqliteId is initialised by initSqliteBaseline() before the
 * camera starts, so existing SQLite rows are never uploaded on sign-in.
 */
async function pollSqliteForNewGestures() {
  try {
    const res = await fetch(`/history?after_id=${lastKnownSqliteId}`);
    if (!res.ok) return;
    const rows = await res.json();
    if (rows.length === 0) return;

    rows.forEach(row => {
      // Advance the high-water mark
      if (row.id > lastKnownSqliteId) lastKnownSqliteId = row.id;

      // Speak the new gesture
      speak(row.gesture);

      // Mirror to the signed-in user's Firestore collection
      if (typeof window.firestoreMirror === "function") {
        window.firestoreMirror(
          row.id,
          row.gesture,
          row.timestamp,
          row.confidence ?? null
        );
      }

      // Forward to the active online room (if any).
      // window.roomGesture is set by index.html when a room becomes active
      // and cleared when it ends or the user leaves.  It is null in Local
      // mode and in all non-active room states, so this call is a no-op
      // outside of an active room.
      // Duplicate prevention: this forEach runs exactly once per row because
      // lastKnownSqliteId advances before this line is reached, so the same
      // SQLite row can never be processed twice.
      if (typeof window.roomGesture === "function") {
        window.roomGesture(row.gesture);
      }
    });
  } catch { /* silently ignore */ }
}

/**
 * Fetch the current SQLite max id without rendering anything.
 * Call this once after auth is confirmed, before starting the camera.
 * This sets lastKnownSqliteId so that existing shared SQLite rows are
 * never uploaded to the signed-in user's Firestore collection.
 */
async function initSqliteBaseline() {
  try {
    const res  = await fetch("/history");
    if (!res.ok) return;
    const rows = await res.json();
    if (rows.length > 0) {
      // rows is oldest-first; take the last id as the baseline
      lastKnownSqliteId = rows[rows.length - 1].id;
    }
  } catch { /* non-fatal */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Camera controls & Active Room stream integration
// ═══════════════════════════════════════════════════════════════════════════

function setCameraButtonsState(starting) {
  const startBtns = [
    document.getElementById("btnStart"),
    document.getElementById("btnRoomStart"),
    document.getElementById("roomBtnStart")
  ].filter(Boolean);

  const stopBtns = [
    document.getElementById("btnStop"),
    document.getElementById("btnRoomStop"),
    document.getElementById("roomBtnStop")
  ].filter(Boolean);

  startBtns.forEach(btn => { btn.disabled = starting; });
  stopBtns.forEach(btn => { btn.disabled = !starting; });
}

function syncCameraUI(active) {
  setCameraButtonsState(active);

  const placeholders = [
    document.getElementById("cameraPlaceholder"),
    document.getElementById("roomCameraPlaceholder")
  ].filter(Boolean);

  placeholders.forEach(p => {
    if (active) p.classList.add("hidden");
    else p.classList.remove("hidden");
  });

  const statuses = [
    document.getElementById("cameraStatus"),
    document.getElementById("roomCameraStatus")
  ].filter(Boolean);

  statuses.forEach(s => {
    s.textContent = active ? "● Camera on" : "● Camera off";
    s.className = active ? "camera-status status-on" : "camera-status status-off";
  });
}

let roomCanvasAnimId = null;

function startRoomCanvasLoop() {
  if (roomCanvasAnimId) {
    cancelAnimationFrame(roomCanvasAnimId);
    roomCanvasAnimId = null;
  }

  const canvas = document.getElementById("roomCanvas");
  const video = document.getElementById("roomVideo");
  const roomFeed = document.getElementById("roomVideoFeed");
  const localFeed = document.getElementById("videoFeed");

  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // Attempt to link canvas stream to <video id="roomVideo">
  function connectStreamToVideo() {
    if (video && !video.srcObject && typeof canvas.captureStream === "function") {
      try {
        const stream = canvas.captureStream(30);
        video.srcObject = stream;
        video.play().catch(() => {});
      } catch (e) {
        console.warn("[app] roomVideo captureStream:", e);
      }
    }
  }

  function draw() {
    if (!isRunning) return;

    const source = (roomFeed && roomFeed.naturalWidth > 0)
      ? roomFeed
      : (localFeed && localFeed.naturalWidth > 0 ? localFeed : null);

    if (source && source.naturalWidth > 0) {
      if (canvas.width !== source.naturalWidth || canvas.height !== source.naturalHeight) {
        canvas.width = source.naturalWidth;
        canvas.height = source.naturalHeight;
      }
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      connectStreamToVideo();
    }

    roomCanvasAnimId = requestAnimationFrame(draw);
  }

  roomCanvasAnimId = requestAnimationFrame(draw);
}

function stopRoomCanvasLoop() {
  if (roomCanvasAnimId) {
    cancelAnimationFrame(roomCanvasAnimId);
    roomCanvasAnimId = null;
  }
  const canvas = document.getElementById("roomCanvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  const video = document.getElementById("roomVideo");
  if (video && video.srcObject) {
    try {
      video.srcObject.getTracks().forEach(t => t.stop());
    } catch (e) {}
    video.srcObject = null;
  }
}

async function startCamera() {
  if (isRunning) return;
  setCameraButtonsState(true);

  try {
    const res = await fetch("/start", { method: "POST" });
    if (!res.ok) throw new Error("Server error starting camera");

    isRunning = true;
    window.isRunning = true;

    const localFeed = document.getElementById("videoFeed");
    if (localFeed) localFeed.src = "/video_feed";

    const roomFeed = document.getElementById("roomVideoFeed");
    if (roomFeed) roomFeed.src = "/video_feed";

    startRoomCanvasLoop();
    syncCameraUI(true);

    updateGestureLabel("No Hand Detected");

    // Poll live gesture label every 300 ms
    gesturePollId = setInterval(pollGesture, 300);

    // Poll SQLite for new gestures every 1 s (for TTS + Firestore mirroring + room forwarding)
    sqlitePollId = setInterval(pollSqliteForNewGestures, 1000);

  } catch (err) {
    console.error("Could not start camera:", err);
    syncCameraUI(false);
    updateGestureLabel("Error starting camera");
  }
}

async function stopCamera() {
  if (!isRunning) return;
  const stopBtns = [
    document.getElementById("btnStop"),
    document.getElementById("btnRoomStop"),
    document.getElementById("roomBtnStop")
  ].filter(Boolean);
  stopBtns.forEach(btn => { btn.disabled = true; });

  try {
    await fetch("/stop", { method: "POST" });
  } catch { /* best-effort */ }

  isRunning = false;
  window.isRunning = false;

  const localFeed = document.getElementById("videoFeed");
  if (localFeed) localFeed.src = "";

  const roomFeed = document.getElementById("roomVideoFeed");
  if (roomFeed) roomFeed.src = "";

  stopRoomCanvasLoop();
  syncCameraUI(false);

  clearInterval(gesturePollId);
  clearInterval(sqlitePollId);
  gesturePollId = null;
  sqlitePollId  = null;

  updateGestureLabel("Waiting…");

  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function bindCameraControls() {
  const startBtns = [
    document.getElementById("btnStart"),
    document.getElementById("btnRoomStart"),
    document.getElementById("roomBtnStart")
  ].filter(Boolean);

  const stopBtns = [
    document.getElementById("btnStop"),
    document.getElementById("btnRoomStop"),
    document.getElementById("roomBtnStop")
  ].filter(Boolean);

  startBtns.forEach(btn => {
    btn.removeEventListener("click", startCamera);
    btn.addEventListener("click", startCamera);
  });

  stopBtns.forEach(btn => {
    btn.removeEventListener("click", stopCamera);
    btn.addEventListener("click", stopCamera);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Initialisation
// ═══════════════════════════════════════════════════════════════════════════

if ("speechSynthesis" in window) {
  loadVoices();
  updateRoomVoiceUI();
} else {
  setVoiceNote("Text-to-speech is not supported in this browser.");
  if (btnVoice) btnVoice.disabled = true;
  if (voiceSelect) voiceSelect.disabled = true;
  const btnR = document.getElementById("btnRoomVoice");
  const selR = document.getElementById("roomVoiceSelect");
  if (btnR) btnR.disabled = true;
  if (selR) selR.disabled = true;
}

bindCameraControls();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindCameraControls);
}

// Global exposures
window.startCamera = startCamera;
window.stopCamera = stopCamera;
window.syncCameraUI = syncCameraUI;
window.startRoomCanvasLoop = startRoomCanvasLoop;
window.stopRoomCanvasLoop = stopRoomCanvasLoop;
window.bindCameraControls = bindCameraControls;
window.isRunning = isRunning;

// History is now loaded by the Firestore onSnapshot listener which is
// started by index.html after auth is confirmed.
// initSqliteBaseline() is also called from index.html after auth.
