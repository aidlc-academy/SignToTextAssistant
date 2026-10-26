"""
collect_data.py
---------------
Utility to capture hand landmarks from webcam frames using MediaPipe
and record them into a CSV dataset for machine learning model training.

1. Initializes mediapipe.solutions.hands.
2. Prompts the terminal for a gesture label (e.g., 'A', 'B', 'THANK YOU').
3. Captures 500 frames from the webcam. For every frame a hand is detected,
   extracts the relative 21 (x, y, z) landmark coordinates.
4. Flattens coordinates into a 63-element list.
5. Appends the row to gesture_dataset.csv with the label in the first column
   followed by the 63 coordinate values.
"""

import csv
import os
import sys
import time
import cv2
import mediapipe as mp

# ── MediaPipe Compatibility Layer ─────────────────────────────────────────────
# In MediaPipe 1.x / Python 3.14+, mp.solutions was replaced by mp.tasks.
# This compatibility shim ensures mp.solutions.hands works seamlessly in both
# legacy (0.10.x) and modern (1.x+) MediaPipe installations.
if not hasattr(mp, "solutions"):
    import types

    solutions = types.ModuleType("solutions")
    hands_mod = types.ModuleType("hands")
    drawing_mod = types.ModuleType("drawing_utils")

    class _HandLandmarksShim:
        def __init__(self, raw_landmarks):
            self.raw = raw_landmarks
            self.landmark = raw_landmarks

        def __iter__(self):
            return iter(self.raw)

        def __len__(self):
            return len(self.raw)

        def __getitem__(self, idx):
            return self.raw[idx]

    class _ResultsShim:
        def __init__(self, raw_landmarks_list):
            self.raw_hand_landmarks = raw_landmarks_list if raw_landmarks_list else []
            self.multi_hand_landmarks = (
                [_HandLandmarksShim(l) for l in raw_landmarks_list] if raw_landmarks_list else None
            )

    class _HandsShim:
        def __init__(
            self,
            static_image_mode=False,
            max_num_hands=1,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        ):
            model_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "hand_landmarker.task"
            )
            if not os.path.exists(model_path):
                raise FileNotFoundError(
                    f"Model task file not found at: {model_path}\n"
                    "Ensure 'hand_landmarker.task' is located in the project directory."
                )
            options = mp.tasks.vision.HandLandmarkerOptions(
                base_options=mp.tasks.BaseOptions(model_asset_path=model_path),
                running_mode=mp.tasks.vision.RunningMode.VIDEO,
                num_hands=max_num_hands,
                min_hand_detection_confidence=min_detection_confidence,
                min_tracking_confidence=min_tracking_confidence,
            )
            self._landmarker = mp.tasks.vision.HandLandmarker.create_from_options(options)
            self._timestamp_ms = 0

        def process(self, image_rgb):
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_rgb)
            res = self._landmarker.detect_for_video(mp_image, self._timestamp_ms)
            self._timestamp_ms += 1
            return _ResultsShim(res.hand_landmarks)

        def close(self):
            if hasattr(self, "_landmarker") and self._landmarker:
                self._landmarker.close()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.close()

    hands_mod.Hands = _HandsShim
    hands_mod.HAND_CONNECTIONS = mp.tasks.vision.HandLandmarksConnections.HAND_CONNECTIONS
    drawing_mod.draw_landmarks = mp.tasks.vision.drawing_utils.draw_landmarks
    drawing_mod.DrawingSpec = mp.tasks.vision.drawing_utils.DrawingSpec

    solutions.hands = hands_mod
    solutions.drawing_utils = drawing_mod
    mp.solutions = solutions


# ── Configuration ─────────────────────────────────────────────────────────────
CSV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gesture_dataset.csv")
TOTAL_FRAMES = 500


def init_csv_file(csv_path: str) -> None:
    """Ensure the CSV file exists with standard headers (label + 63 coordinate columns)."""
    file_exists = os.path.exists(csv_path) and os.path.getsize(csv_path) > 0
    if not file_exists:
        header = ["label"]
        for i in range(21):
            header.extend([f"x{i}", f"y{i}", f"z{i}"])
        with open(csv_path, mode="w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(header)


def prompt_for_label() -> str:
    """Prompt the terminal for the gesture label to record."""
    while True:
        try:
            label = input("\nEnter gesture label (e.g., 'A', 'B', 'THANK YOU'): ").strip()
            if label:
                return label
            print("Label cannot be empty. Please enter a valid gesture label.")
        except (EOFError, KeyboardInterrupt):
            print("\nOperation cancelled by user.")
            sys.exit(0)


def collect_landmarks():
    """Main data collection routine."""
    print("=" * 65)
    print("  MediaPipe Hand Landmark Data Collection for ML Training")
    print("=" * 65)

    # 1. Initialize mediapipe.solutions.hands
    mp_hands = mp.solutions.hands
    mp_drawing = mp.solutions.drawing_utils

    hands = mp_hands.Hands(
        static_image_mode=False,
        max_num_hands=1,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    # 2. Prompt the terminal for a label
    label = prompt_for_label()

    init_csv_file(CSV_FILE)

    # Initialize webcam
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Error: Could not open webcam.")
        print("Please ensure your camera is connected and not in use by another program.")
        sys.exit(1)

    print("\n-----------------------------------------------------------------")
    print(f"Target Label    : {label}")
    print(f"Target CSV File : {CSV_FILE}")
    print(f"Target Frames   : {TOTAL_FRAMES} frames")
    print("-----------------------------------------------------------------")
    print("Starting in 3 seconds. Position your hand in front of the camera...")

    # 3-second preparation countdown with camera preview
    countdown_start = time.time()
    while time.time() - countdown_start < 3.0:
        ret, frame = cap.read()
        if not ret:
            break
        frame = cv2.flip(frame, 1)
        remaining = 3 - int(time.time() - countdown_start)
        cv2.putText(
            frame,
            f"Get Ready! Starting in {remaining}...",
            (30, 80),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.95,
            (0, 255, 255),
            2,
            cv2.LINE_AA,
        )
        cv2.imshow("Hand Landmark Data Collection", frame)
        if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
            print("Aborted during countdown.")
            cap.release()
            cv2.destroyAllWindows()
            hands.close()
            return

    recorded_samples = 0
    actual_frames = 0

    print(f"\nRecording {TOTAL_FRAMES} frames now. Press 'q' or ESC in the window to stop early.\n")

    try:
        # 3. Capture 500 frames from the webcam
        for frame_idx in range(1, TOTAL_FRAMES + 1):
            ret, frame = cap.read()
            if not ret:
                print(f"Warning: Could not read frame {frame_idx} from webcam.")
                break

            actual_frames += 1

            # Mirror frame for natural user interaction
            frame = cv2.flip(frame, 1)

            # Convert BGR image to RGB for MediaPipe processing
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = hands.process(rgb_frame)

            hand_detected = False

            # Check if a hand is detected in this frame
            if results.multi_hand_landmarks:
                hand_detected = True
                for i, hand_landmarks in enumerate(results.multi_hand_landmarks):
                    # Pass the original raw hand_landmarks object from the MediaPipe results array
                    # to mp_drawing.draw_landmarks(), not the custom shim
                    raw_landmarks = (
                        results.raw_hand_landmarks[i]
                        if hasattr(results, "raw_hand_landmarks") and i < len(results.raw_hand_landmarks)
                        else getattr(hand_landmarks, "raw", hand_landmarks)
                    )

                    # Draw landmark skeleton on visualization feed using raw MediaPipe landmark list
                    mp_drawing.draw_landmarks(
                        frame,
                        raw_landmarks,
                        mp_hands.HAND_CONNECTIONS,
                    )

                    # 3 & 4. Use the shim exclusively for extracting relative 21 (x, y, z) float coordinates
                    landmarks_flat = []
                    for lm in hand_landmarks.landmark:
                        landmarks_flat.extend([float(lm.x), float(lm.y), float(lm.z)])

                    if len(landmarks_flat) == 63:
                        # 5. Append row to CSV: label in first column followed by 63 coordinate values
                        row = [label] + landmarks_flat
                        with open(CSV_FILE, mode="a", newline="", encoding="utf-8") as f:
                            writer = csv.writer(f)
                            writer.writerow(row)
                        recorded_samples += 1

                    # One hand per frame
                    break

            # Overlay information HUD
            h, w = frame.shape[:2]
            cv2.rectangle(frame, (0, 0), (w, 75), (20, 24, 36), -1)

            cv2.putText(
                frame,
                f"Label: {label} | Progress: {frame_idx}/{TOTAL_FRAMES}",
                (15, 28),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                (255, 255, 255),
                2,
                cv2.LINE_AA,
            )

            status_str = f"Hand: {'DETECTED' if hand_detected else 'NOT DETECTED'} | Saved Samples: {recorded_samples}"
            status_col = (0, 230, 0) if hand_detected else (0, 80, 240)
            cv2.putText(
                frame,
                status_str,
                (15, 58),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.62,
                status_col,
                2,
                cv2.LINE_AA,
            )

            cv2.putText(
                frame,
                "Press 'q' or ESC to stop",
                (15, h - 12),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.48,
                (170, 170, 170),
                1,
                cv2.LINE_AA,
            )

            cv2.imshow("Hand Landmark Data Collection", frame)

            # Check for user interrupt
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                print(f"\nStopped by user at frame {frame_idx}.")
                break

    finally:
        cap.release()
        cv2.destroyAllWindows()
        hands.close()

    print("\n" + "=" * 65)
    print("  Collection Complete Summary")
    print("=" * 65)
    print(f"Gesture Label    : {label}")
    print(f"Frames Captured  : {actual_frames} / {TOTAL_FRAMES}")
    print(f"Samples Recorded : {recorded_samples} (where hand was detected)")
    print(f"Dataset File     : {CSV_FILE}")
    print("=" * 65 + "\n")


if __name__ == "__main__":
    collect_landmarks()
