# Product — Sign-to-Text Communication Assistant

## Purpose

A beginner-friendly web application that uses a laptop webcam to recognise
predefined hand gestures and display the corresponding text on screen.
It is a limited-gesture demo, not a complete sign-language translator.

## Target users

- Individuals who need a basic sign-to-text communication aid.
- Developers learning MediaPipe, Flask, or Firebase integration.

## Current features

### Local Translation mode (fully working)

- Webcam capture via OpenCV served as an MJPEG stream from the Flask backend.
- Hand landmark detection using MediaPipe `HandLandmarker` (tasks API, VIDEO mode).
- Rule-based gesture classification for exactly six gestures:
  - **HELLO** — open palm, fingers spread wide
  - **STOP** — open palm, fingers held together
  - **OK** — thumb and index fingertips touching
  - **YES** — thumb pointing straight up
  - **ONE** — only index finger extended
  - **VICTORY** — index and middle fingers extended (V sign)
- 5-frame rolling stability filter and confidence scoring per gesture.
- Translation text displayed in a chat-style history panel with WhatsApp-style
  date grouping (Today / Yesterday / date).
- Browser text-to-speech (Web Speech API) with male/female voice selection.
- Firebase Email/Password authentication (sign-up, sign-in, sign-out).
- Per-user Firestore translation history under `users/{uid}/translations`.
- SQLite (`history.db`) used server-side for gesture detection; new gestures
  are mirrored to Firestore via the client.
- Clear History deletes the signed-in user's Firestore documents only.

### Online Communication mode (partially implemented)

The UI shell is present with two-tab navigation (Local Translation /
Online Communication). The Online Communication panel contains:

- **Lobby view** — a "Start a Session" form for entering a participant's email
  and an "Invitations" panel for incoming invitations.
- **Waiting view** — shown to the creator while waiting for the invitee to accept.
- **Room view** — shown when both users are in the room.

Room creation, invitation sending, and invitation acceptance are implemented
in `static/room.js`. Invitations are stored in Firestore under
`invitations/{emailHash}/pendingInvites/{roomId}`.

**Not yet implemented:**
- Real-time text messaging between participants.
- WebRTC video calling.
- Gesture translation appearing on the remote participant's screen.
- Listener text replies.
- Invitation expiry enforcement in Firestore Security Rules.

## Known limitations

- Gesture recognition is rule-based and limited to the six gestures above.
  No machine-learning model is used for classification.
- The webcam is opened on the Flask server machine; remote participants
  cannot contribute their own camera feed yet.
- Invitation expiry (`expiresAt` field) is stored but not yet enforced by
  Firestore Security Rules (tracked as a planned improvement).
- If the room-creation invitation write fails, an orphaned room may remain
  until the creator cancels (cleanup improvement is planned).
- No rate limiting on room or invitation creation.
