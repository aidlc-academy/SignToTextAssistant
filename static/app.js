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

let voiceEnabled  = false;
let selectedVoice = null;
let allVoices     = [];

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
  const gender = voiceSelect.value;
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
}

function setVoiceNote(text) { voiceNote.textContent = text; }

function speak(text) {
  if (!voiceEnabled || !("speechSynthesis" in window) || !selectedVoice) return;
  window.speechSynthesis.cancel();
  const u    = new SpeechSynthesisUtterance(text);
  u.voice    = selectedVoice;
  u.lang     = "en-US";
  u.rate     = 0.95;
  u.pitch    = 1.0;
  u.volume   = 1.0;
  window.speechSynthesis.speak(u);
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

function onVoiceSelectChange() { pickVoice(); }

// ═══════════════════════════════════════════════════════════════════════════
// 4. Live gesture label
// ═══════════════════════════════════════════════════════════════════════════

function updateGestureLabel(label) {
  let stateClass;
  if (label === "No Hand Detected")                         stateClass = "state-none";
  else if (label === "Unknown Gesture" || label === "Waiting…") stateClass = "state-unknown";
  else                                                      stateClass = "state-known";

  if (gestureLabel.textContent === label) return;
  gestureLabel.textContent = label;
  gestureLabel.classList.remove("state-idle","state-known","state-unknown","state-none");
  gestureLabel.classList.add(stateClass);
  gestureLabel.classList.remove("pop");
  void gestureLabel.offsetWidth;
  gestureLabel.classList.add("pop");
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
// 7. Camera controls
// ═══════════════════════════════════════════════════════════════════════════

async function startCamera() {
  if (isRunning) return;
  btnStart.disabled = true;

  try {
    const res = await fetch("/start", { method: "POST" });
    if (!res.ok) throw new Error("Server error starting camera");

    isRunning     = true;
    videoFeed.src = "/video_feed";
    cameraPlaceholder.classList.add("hidden");

    btnStop.disabled         = false;
    cameraStatus.textContent = "● Camera on";
    cameraStatus.className   = "camera-status status-on";

    updateGestureLabel("No Hand Detected");

    // Poll live gesture label every 300 ms
    gesturePollId = setInterval(pollGesture, 300);

    // Poll SQLite for new gestures every 1 s (for TTS + Firestore mirroring)
    // Note: this does NOT render rows to the chat panel.
    sqlitePollId = setInterval(pollSqliteForNewGestures, 1000);

  } catch (err) {
    console.error("Could not start camera:", err);
    btnStart.disabled = false;
    updateGestureLabel("Error starting camera");
  }
}

async function stopCamera() {
  if (!isRunning) return;
  btnStop.disabled = true;

  try {
    await fetch("/stop", { method: "POST" });
  } catch { /* best-effort */ }

  isRunning     = false;
  videoFeed.src = "";
  cameraPlaceholder.classList.remove("hidden");

  clearInterval(gesturePollId);
  clearInterval(sqlitePollId);
  gesturePollId = null;
  sqlitePollId  = null;

  btnStart.disabled        = false;
  cameraStatus.textContent = "● Camera off";
  cameraStatus.className   = "camera-status status-off";

  gestureLabel.textContent = "Waiting…";
  gestureLabel.classList.remove("state-known","state-unknown","state-none","pop");
  gestureLabel.classList.add("state-idle");

  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Initialisation
// ═══════════════════════════════════════════════════════════════════════════

if ("speechSynthesis" in window) {
  loadVoices();
} else {
  setVoiceNote("Text-to-speech is not supported in this browser.");
  btnVoice.disabled    = true;
  voiceSelect.disabled = true;
}

// History is now loaded by the Firestore onSnapshot listener which is
// started by index.html after auth is confirmed.
// initSqliteBaseline() is also called from index.html after auth.
