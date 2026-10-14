"""
app.py
------
Flask web application for the Sign-to-Text Communication Assistant.

Endpoints
---------
GET  /              → serves the HTML page
GET  /video_feed    → MJPEG stream (annotated webcam frames)
GET  /gesture       → JSON {"gesture": "<label>"}
POST /start         → starts the camera capture thread
POST /stop          → stops the camera capture thread
GET  /history       → JSON list of saved translations (supports ?after_id=N)
DELETE /history     → deletes all translation history
"""

import os
import sys
import threading
import time

import cv2
import mediapipe as mp
from flask import Flask, Response, jsonify, render_template, request

from gesture import classify_gesture
from database import init_db, save_translation, get_history, clear_history

# ── Flask app ────────────────────────────────────────────────────────────────

app = Flask(__name__)

# Initialise the SQLite database (creates the table if it doesn't exist yet)
init_db()

# ── MediaPipe setup ──────────────────────────────────────────────────────────

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "hand_landmarker.task")

HandLandmarker        = mp.tasks.vision.HandLandmarker
HandLandmarkerOptions = mp.tasks.vision.HandLandmarkerOptions
RunningMode           = mp.tasks.vision.RunningMode
BaseOptions           = mp.tasks.BaseOptions
draw_landmarks        = mp.tasks.vision.drawing_utils.draw_landmarks
HandConnections       = mp.tasks.vision.HandLandmarksConnections
DrawingSpec           = mp.tasks.vision.drawing_utils.DrawingSpec

# How long (seconds) a gesture must be held continuously before it is saved.
SAVE_HOLD_SECONDS = 1.5

# After a gesture is saved, ignore that same gesture for this many seconds.
SAME_GESTURE_COOLDOWN = 3.0

# ── Stability filter settings ────────────────────────────────────────────────
# The raw per-frame classification can flicker between labels when the hand
# is between poses.  We pass each raw label through a small rolling window
# and only promote a label to "current" when it is the majority result over
# the last STABILITY_WINDOW frames AND its average confidence clears the
# CONFIDENCE_THRESHOLD.  This smooths the displayed label without adding
# perceptible latency (at 30 fps a window of 5 = ~167 ms).

STABILITY_WINDOW      = 5     # number of recent frames to consider
CONFIDENCE_THRESHOLD  = 0.45  # minimum average confidence to accept a label


def _make_landmarker():
    """Create a HandLandmarker in VIDEO mode for frame-by-frame processing."""
    options = HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=MODEL_PATH),
        running_mode=RunningMode.VIDEO,
        num_hands=1,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return HandLandmarker.create_from_options(options)


# ── Shared camera state ──────────────────────────────────────────────────────
# Written by the capture thread, read by the streaming and gesture endpoints.
# A threading.Lock protects all shared variables.

_lock            = threading.Lock()
_current_frame   = None              # latest JPEG bytes
_current_gesture = "No Hand Detected"
_current_confidence = 0.0            # confidence score for the current gesture
_capture_thread  = None
_running         = False             # set to False to stop the capture thread


def _draw_landmarks_on_frame(frame, hand_landmarks_list):
    """Draw green landmark dots and white connection lines on the frame."""
    landmark_style   = DrawingSpec(color=(0, 255, 0),    thickness=2, circle_radius=4)
    connection_style = DrawingSpec(color=(255, 255, 255), thickness=2)
    for hand_landmarks in hand_landmarks_list:
        draw_landmarks(
            image=frame,
            landmark_list=hand_landmarks,
            connections=HandConnections.HAND_CONNECTIONS,
            landmark_drawing_spec=landmark_style,
            connection_drawing_spec=connection_style,
        )


def _overlay_text(frame, label, confidence=0.0):
    """
    Overlay the gesture label and confidence score in the top-left corner.
    Confidence is shown as a percentage only for real gestures.
    """
    if label == "No Hand Detected":
        color = (0, 0, 220)
    elif label == "Unknown Gesture":
        color = (0, 140, 255)
    else:
        color = (0, 200, 0)

    cv2.putText(
        img=frame,
        text=label,
        org=(20, 55),
        fontFace=cv2.FONT_HERSHEY_SIMPLEX,
        fontScale=1.2,
        color=color,
        thickness=3,
        lineType=cv2.LINE_AA,
    )

    # Show confidence percentage beneath the label for real gestures
    if label not in ("No Hand Detected", "Unknown Gesture") and confidence > 0:
        conf_text = f"Confidence: {int(confidence * 100)}%"
        cv2.putText(
            img=frame,
            text=conf_text,
            org=(20, 90),
            fontFace=cv2.FONT_HERSHEY_SIMPLEX,
            fontScale=0.65,
            color=color,
            thickness=2,
            lineType=cv2.LINE_AA,
        )


def _capture_loop():
    """
    Background thread: opens the webcam, runs MediaPipe on each frame,
    applies a stability filter to smooth the gesture label, overlays the
    result, and saves confirmed gestures to the database.

    Stability filter
    ----------------
    Each frame produces a raw (label, confidence) from classify_gesture().
    We keep a rolling deque of the last STABILITY_WINDOW raw results.
    The *stable* label is the majority label in that window, provided its
    average confidence meets CONFIDENCE_THRESHOLD.  If neither condition
    is met we show "Unknown Gesture" instead of the raw noisy result.

    This prevents rapid flickering between gesture labels when the hand is
    transitioning between poses.

    Duplicate-suppression
    ---------------------
    Saves to the database only when:
      1. The stable label is a real gesture
      2. It has been held for >= SAVE_HOLD_SECONDS
      3. It differs from the last saved gesture OR enough cooldown has elapsed
    """
    global _current_frame, _current_gesture, _current_confidence, _running

    import collections

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Error: Could not open webcam in capture thread.")
        _running = False
        return

    frame_timestamp_ms = 0

    # Rolling window of (label, confidence) tuples
    raw_window = collections.deque(maxlen=STABILITY_WINDOW)

    # Duplicate-suppression state
    _hold_gesture  = None
    _hold_start    = None
    _last_saved    = None
    _last_saved_at = 0.0

    with _make_landmarker() as landmarker:
        while _running:
            success, frame = cap.read()
            if not success:
                time.sleep(0.01)
                continue

            # ── MediaPipe detection ───────────────────────────────────────
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image  = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)

            result = landmarker.detect_for_video(mp_image, frame_timestamp_ms)
            frame_timestamp_ms += 1

            if result.hand_landmarks:
                _draw_landmarks_on_frame(frame, result.hand_landmarks)
                raw_label, raw_conf = classify_gesture(result.hand_landmarks[0])
            else:
                raw_label, raw_conf = "No Hand Detected", 0.0

            # ── Stability filter ──────────────────────────────────────────
            raw_window.append((raw_label, raw_conf))

            if raw_label == "No Hand Detected":
                # No hand visible — bypass filter, show immediately
                stable_label = "No Hand Detected"
                stable_conf  = 0.0
            else:
                # Find the majority label in the window
                label_counts = collections.Counter(lbl for lbl, _ in raw_window)
                top_label, top_count = label_counts.most_common(1)[0]

                # Calculate average confidence for the majority label
                top_confs = [c for lbl, c in raw_window if lbl == top_label]
                avg_conf  = sum(top_confs) / len(top_confs)

                # Accept the majority label only if it dominates the window
                # and its confidence is high enough
                majority_fraction = top_count / len(raw_window)
                if majority_fraction >= 0.6 and avg_conf >= CONFIDENCE_THRESHOLD:
                    stable_label = top_label
                    stable_conf  = avg_conf
                else:
                    # Window is still mixed — treat as unknown while transitioning
                    stable_label = "Unknown Gesture"
                    stable_conf  = 0.0

            _overlay_text(frame, stable_label, stable_conf)

            # ── Duplicate-suppression & DB save ──────────────────────────
            now      = time.monotonic()
            saveable = stable_label not in ("No Hand Detected", "Unknown Gesture")

            if saveable:
                if stable_label != _hold_gesture:
                    _hold_gesture = stable_label
                    _hold_start   = now
                else:
                    held_for         = now - _hold_start
                    gesture_changed  = stable_label != _last_saved
                    cooldown_elapsed = (now - _last_saved_at) >= SAME_GESTURE_COOLDOWN

                    if held_for >= SAVE_HOLD_SECONDS and (gesture_changed or cooldown_elapsed):
                        save_translation(stable_label)
                        _last_saved    = stable_label
                        _last_saved_at = now
                        _hold_start    = now + SAME_GESTURE_COOLDOWN
            else:
                if stable_label == "No Hand Detected":
                    _hold_gesture = None
                    _hold_start   = None
                    raw_window.clear()   # reset window when hand leaves frame

            # ── Frame encoding ────────────────────────────────────────────
            _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            jpeg_bytes = jpeg.tobytes()

            with _lock:
                _current_frame      = jpeg_bytes
                _current_gesture    = stable_label
                _current_confidence = stable_conf

    cap.release()
    with _lock:
        _current_frame      = None
        _current_gesture    = "No Hand Detected"
        _current_confidence = 0.0


def _generate_mjpeg():
    """
    Generator for the /video_feed MJPEG stream.
    Yields multipart chunks the browser renders as a continuous video.
    """
    while True:
        with _lock:
            frame = _current_frame

        if frame is None:
            time.sleep(0.05)
            continue

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n"
            + frame +
            b"\r\n"
        )
        time.sleep(0.033)   # ~30 fps cap


# ── Routes ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Serve the main dashboard page."""
    return render_template("index.html")


# ── Auth pages ────────────────────────────────────────────────────────────────
# These routes simply render the HTML shells.  All authentication logic runs
# entirely in the browser via the Firebase JS SDK — there is no server-side
# session or credential handling here.

@app.route("/login")
def login():
    """Serve the login page."""
    return render_template("login.html")


@app.route("/register")
def register_page():
    """Serve the registration page."""
    return render_template("register.html")


@app.route("/video_feed")
def video_feed():
    """Return a streaming MJPEG response."""
    return Response(
        _generate_mjpeg(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.route("/gesture")
def gesture_route():
    """Return the most recently recognised gesture and its confidence as JSON."""
    with _lock:
        label = _current_gesture
        conf  = _current_confidence
    return jsonify({"gesture": label, "confidence": round(conf, 2)})


@app.route("/start", methods=["POST"])
def start_camera():
    """Start the background capture thread if it isn't already running."""
    global _capture_thread, _running

    if _running:
        return jsonify({"status": "already running"})

    _running = True
    _capture_thread = threading.Thread(target=_capture_loop, daemon=True)
    _capture_thread.start()
    return jsonify({"status": "started"})


@app.route("/stop", methods=["POST"])
def stop_camera():
    """Signal the capture thread to stop."""
    global _running
    _running = False
    return jsonify({"status": "stopped"})


@app.route("/history", methods=["GET"])
def history_get():
    """
    Return saved translations as a JSON array.

    Optional query param:  ?after_id=<int>
    When supplied, only rows with id > after_id are returned.
    This lets the frontend poll for *new* rows only instead of
    fetching the full history every time.
    """
    try:
        after_id = int(request.args.get("after_id", 0))
    except ValueError:
        after_id = 0

    rows = get_history(after_id=after_id)
    return jsonify(rows)


@app.route("/history", methods=["DELETE"])
def history_delete():
    """Delete all translation history rows."""
    deleted = clear_history()
    return jsonify({"status": "cleared", "deleted": deleted})


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not os.path.exists(MODEL_PATH):
        print(f"Error: Model file not found at:\n  {MODEL_PATH}")
        print("Make sure 'hand_landmarker.task' is in the same folder as app.py.")
        sys.exit(1)

    print("Starting Sign-to-Text Web App...")
    print("Open your browser at: http://127.0.0.1:5000")
    print("Press Ctrl+C to quit.")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
