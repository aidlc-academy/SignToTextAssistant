"""
Basic Sign-to-Text Communication Assistant
Step 4: Gesture Recognition (revised)

Opens the webcam, detects one hand using MediaPipe,
draws the hand landmarks, and classifies the hand pose
into one of six predefined gestures:

  Open palm (fingers spread)   → "HELLO"
  Open palm (fingers together) → "STOP"
  Thumb + index circle         → "OK"
  Thumb pointing upward        → "YES"
  Only index finger extended   → "ONE"
  Index + middle extended      → "VICTORY"

Displays "Unknown Gesture" when no rule matches.
Displays "No Hand Detected" when no hand is visible.
Press 'q' to quit.
"""

import cv2
import mediapipe as mp
import sys
import os

# Gesture classification logic lives in gesture.py so it can be shared
# with the Flask web app (app.py) without duplicating code.
from gesture import classify_gesture

# ── MediaPipe shortcuts ──────────────────────────────────────────────────────

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "hand_landmarker.task")

HandLandmarker        = mp.tasks.vision.HandLandmarker
HandLandmarkerOptions = mp.tasks.vision.HandLandmarkerOptions
RunningMode           = mp.tasks.vision.RunningMode
BaseOptions           = mp.tasks.BaseOptions
draw_landmarks        = mp.tasks.vision.drawing_utils.draw_landmarks
HandConnections       = mp.tasks.vision.HandLandmarksConnections
DrawingSpec           = mp.tasks.vision.drawing_utils.DrawingSpec

# ── Drawing helpers ──────────────────────────────────────────────────────────

def draw_hand(frame, hand_landmarks_list):
    """
    Draw all hand landmarks (green dots) and bone connections (white lines)
    onto the given frame. Works in-place.
    """
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


def put_gesture_text(frame, gesture_label, confidence=0.0):
    """
    Overlay the gesture label and confidence score on the frame.

    Colour coding:
      Known gesture  → green
      Unknown        → orange
      No hand        → red
    """
    if gesture_label == "No Hand Detected":
        color = (0, 0, 220)      # red
    elif gesture_label == "Unknown Gesture":
        color = (0, 140, 255)    # orange
    else:
        color = (0, 200, 0)      # green

    cv2.putText(
        img=frame,
        text=gesture_label,
        org=(20, 55),
        fontFace=cv2.FONT_HERSHEY_SIMPLEX,
        fontScale=1.3,
        color=color,
        thickness=3,
        lineType=cv2.LINE_AA,
    )

    # Show confidence beneath the label for real recognised gestures
    if gesture_label not in ("No Hand Detected", "Unknown Gesture") and confidence > 0:
        conf_text = f"Confidence: {int(confidence * 100)}%"
        cv2.putText(
            img=frame,
            text=conf_text,
            org=(20, 95),
            fontFace=cv2.FONT_HERSHEY_SIMPLEX,
            fontScale=0.7,
            color=color,
            thickness=2,
            lineType=cv2.LINE_AA,
        )


def put_hint_text(frame):
    """
    Show a small hint at the bottom of the frame listing available gestures.
    """
    hint = "Gestures: HELLO | STOP | OK | YES | ONE | VICTORY"
    cv2.putText(
        img=frame,
        text=hint,
        org=(10, frame.shape[0] - 15),   # near the bottom edge
        fontFace=cv2.FONT_HERSHEY_SIMPLEX,
        fontScale=0.55,
        color=(200, 200, 200),           # light grey
        thickness=1,
        lineType=cv2.LINE_AA,
    )


# ── MediaPipe setup ──────────────────────────────────────────────────────────

def check_model_file():
    """Exit with a clear message if the model file is missing."""
    if not os.path.exists(MODEL_PATH):
        print(f"Error: Model file not found at:\n  {MODEL_PATH}")
        print("Please ensure 'hand_landmarker.task' is in the same folder as main.py.")
        sys.exit(1)


def create_hand_landmarker():
    """
    Build a HandLandmarker in VIDEO running mode.
    VIDEO mode processes frames sequentially and uses tracking between
    frames, which is smoother and faster than IMAGE mode for a webcam feed.
    """
    options = HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=MODEL_PATH),
        running_mode=RunningMode.VIDEO,
        num_hands=1,                       # we only need one hand
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return HandLandmarker.create_from_options(options)


# ── Main loop ────────────────────────────────────────────────────────────────

def main():
    check_model_file()

    # Open the default webcam (index 0 = built-in laptop camera)
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Error: Could not open webcam.")
        print("Make sure your webcam is connected and not used by another app.")
        sys.exit(1)

    print("Webcam opened. Press 'q' in the video window to quit.")
    print("Try these gestures:")
    print("  Open palm (spread)   → HELLO")
    print("  Open palm (together) → STOP")
    print("  Thumb + index circle → OK")
    print("  Thumb pointing up    → YES")
    print("  Index finger only    → ONE")
    print("  Index + middle       → VICTORY")

    # VIDEO mode requires a monotonically increasing timestamp in milliseconds.
    # We increment by 1 ms per frame — simple and reliable for webcam input.
    frame_timestamp_ms = 0

    with create_hand_landmarker() as landmarker:
        while True:
            success, frame = cap.read()
            if not success:
                print("Error: Could not read a frame from the webcam.")
                break

            # ── Prepare image for MediaPipe ───────────────────────────────
            # OpenCV uses BGR colour order; MediaPipe requires RGB.
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image  = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)

            # ── Run hand detection ────────────────────────────────────────
            result = landmarker.detect_for_video(mp_image, frame_timestamp_ms)
            frame_timestamp_ms += 1   # advance the timestamp by 1 ms

            # ── Decide what to display ────────────────────────────────────
            if len(result.hand_landmarks) == 0:
                gesture_label = "No Hand Detected"
                confidence    = 0.0
            else:
                # Hand found — draw it, then classify the gesture
                draw_hand(frame, result.hand_landmarks)
                gesture_label, confidence = classify_gesture(result.hand_landmarks[0])

            # ── Overlay text on the frame ─────────────────────────────────
            put_gesture_text(frame, gesture_label, confidence)
            put_hint_text(frame)

            # ── Display the frame ─────────────────────────────────────────
            cv2.imshow("Sign-to-Text Assistant", frame)

            # Exit when the user presses 'q'
            if cv2.waitKey(1) & 0xFF == ord("q"):
                print("Exiting... Goodbye!")
                break

    # Always release the webcam and close windows, even if an error occurred
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
