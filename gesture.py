"""
gesture.py
----------
Landmark-based gesture classification logic.

Shared between:
  - main.py  (standalone OpenCV window mode)
  - app.py   (Flask web application mode)

Accuracy improvements
---------------------
1. Hand-size normalisation
   All distance thresholds are divided by hand_scale (wrist-to-middle-MCP).
   Makes every threshold scale-invariant across camera distances.

2. Two-joint finger check
   is_finger_up() requires the tip above BOTH PIP and MCP, preventing a
   slightly bent finger from counting as extended.

3. Improved YES detection
   Thumb must travel more vertically than horizontally (pointing up, not
   sideways) and rise clearly above the wrist.

4. Confidence score
   classify_gesture() returns (label, confidence) 0.0-1.0.

5. HELLO vs STOP: two-signal approach
   Uses adjacent-finger spread sum AND thumb horizontal abduction to
   separate the two gestures reliably (see detailed comments below).

Public API
----------
classify_gesture(lm)  ->  (label: str, confidence: float)
"""

import math

# ── Hand landmark indices ────────────────────────────────────────────────────
#
#   0  = WRIST
#   Thumb  : 1(CMC)  2(MCP)  3(IP)   4(TIP)
#   Index  : 5(MCP)  6(PIP)  7(DIP)  8(TIP)
#   Middle : 9(MCP) 10(PIP) 11(DIP) 12(TIP)
#   Ring   :13(MCP) 14(PIP) 15(DIP) 16(TIP)
#   Pinky  :17(MCP) 18(PIP) 19(DIP) 20(TIP)

WRIST      = 0

THUMB_TIP  = 4
THUMB_IP   = 3
THUMB_MCP  = 2
THUMB_CMC  = 1

INDEX_TIP  = 8
INDEX_MCP  = 5
INDEX_PIP  = 6
INDEX_DIP  = 7

MIDDLE_TIP = 12
MIDDLE_MCP = 9
MIDDLE_PIP = 10

RING_TIP   = 16
RING_MCP   = 13
RING_PIP   = 14

PINKY_TIP  = 20
PINKY_MCP  = 17
PINKY_PIP  = 18

FINGER_TIPS = [INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP]
FINGER_PIPS = [INDEX_PIP, MIDDLE_PIP, RING_PIP, PINKY_PIP]
FINGER_MCPS = [INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP]


# ── Geometry helpers ─────────────────────────────────────────────────────────

def _dist(lm, a, b):
    """Raw Euclidean distance between two normalised landmarks."""
    dx = lm[a].x - lm[b].x
    dy = lm[a].y - lm[b].y
    return math.sqrt(dx * dx + dy * dy)


def _hand_scale(lm):
    """
    Scale factor = distance from wrist to middle-finger MCP.
    Dividing by this makes all other distances scale-invariant regardless
    of how close the hand is to the camera.  Floor of 0.01 prevents /0.
    """
    return max(_dist(lm, WRIST, MIDDLE_MCP), 0.01)


def _norm_dist(lm, a, b, scale):
    """Euclidean distance between landmarks a and b, normalised by scale."""
    return _dist(lm, a, b) / scale


def is_finger_up(lm, tip, pip, mcp):
    """
    True when a finger is clearly extended upward.
    Two-joint check: tip must be above (smaller y) both PIP and MCP.
    The MCP check has a small margin to avoid false positives on
    nearly-horizontal hands.
    """
    tip_above_pip = lm[tip].y < lm[pip].y
    tip_above_mcp = lm[tip].y < lm[mcp].y - 0.01
    return tip_above_pip and tip_above_mcp


def _finger_curl(lm, tip, mcp, scale):
    """
    Normalised tip-to-MCP distance.
    Small = finger is curled; large = finger is extended.
    Used as a secondary confidence signal.
    """
    return _norm_dist(lm, tip, mcp, scale)


# ── Gesture classification ────────────────────────────────────────────────────

def classify_gesture(lm):
    """
    Classify a hand pose from 21 NormalizedLandmark objects.

    Returns
    -------
    (label, confidence)
      label      : str   -- gesture name or "Unknown Gesture"
      confidence : float -- 0.0 (weak) to 1.0 (strong match)

    Check order (most-specific first to avoid rule overlap):
      1. OK      -- thumb + index tips touching, other 3 fingers up
      2. ONE     -- only index finger extended
      3. VICTORY -- index + middle up, ring + pinky folded
      4. YES     -- thumb pointing clearly upward, all 4 fingers folded
      5. HELLO   -- all 4 fingers extended, fanned wide, thumb abducted
      6. STOP    -- all 4 fingers extended, held together, thumb beside palm
      7. Unknown -- no rule matched
    """
    # ── Normalisation ────────────────────────────────────────────────────
    scale = _hand_scale(lm)

    # ── Per-finger extension state ────────────────────────────────────────
    index_up  = is_finger_up(lm, INDEX_TIP,  INDEX_PIP,  INDEX_MCP)
    middle_up = is_finger_up(lm, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP)
    ring_up   = is_finger_up(lm, RING_TIP,   RING_PIP,   RING_MCP)
    pinky_up  = is_finger_up(lm, PINKY_TIP,  PINKY_PIP,  PINKY_MCP)
    n_up      = sum([index_up, middle_up, ring_up, pinky_up])

    # Pre-compute values reused by multiple rules
    thumb_index_dist = _norm_dist(lm, THUMB_TIP, INDEX_TIP, scale)

    # ── 1. OK ─────────────────────────────────────────────────────────────
    # Thumb tip and index tip touching (< 25% of hand scale).
    # Middle, ring, pinky all extended.
    OK_TOUCH_THRESHOLD = 0.25
    if (thumb_index_dist < OK_TOUCH_THRESHOLD
            and middle_up and ring_up and pinky_up):
        conf = 1.0 - (thumb_index_dist / OK_TOUCH_THRESHOLD) * 0.5
        return "OK", round(conf, 2)

    # ── 2. ONE ────────────────────────────────────────────────────────────
    # Only index finger extended; all others folded.
    if index_up and not middle_up and not ring_up and not pinky_up:
        extension = _finger_curl(lm, INDEX_TIP, INDEX_MCP, scale)
        conf = min(extension / 0.7, 1.0)
        return "ONE", round(conf, 2)

    # ── 3. VICTORY ────────────────────────────────────────────────────────
    # Index + middle up; ring + pinky down.
    if index_up and middle_up and not ring_up and not pinky_up:
        v_spread = _norm_dist(lm, INDEX_TIP, MIDDLE_TIP, scale)
        ext_avg  = ((_finger_curl(lm, INDEX_TIP,  INDEX_MCP,  scale) +
                     _finger_curl(lm, MIDDLE_TIP, MIDDLE_MCP, scale)) / 2)
        conf = min(ext_avg / 0.7, 1.0) * min(v_spread / 0.15, 1.0)
        return "VICTORY", round(conf, 2)

    # ── 4. YES (thumb-up) ─────────────────────────────────────────────────
    # All four fingers folded AND thumb tip clearly above the wrist AND
    # thumb pointing more vertically than horizontally.
    if n_up == 0:
        thumb_rise = lm[WRIST].y - lm[THUMB_TIP].y   # positive = tip higher
        thumb_h    = abs(lm[THUMB_TIP].x - lm[THUMB_MCP].x)
        thumb_v    = abs(lm[THUMB_TIP].y - lm[THUMB_MCP].y)
        above_wrist = thumb_rise > scale * 0.08
        pointing_up = thumb_v > thumb_h
        if above_wrist and pointing_up:
            conf = min(thumb_rise / (scale * 0.3), 1.0)
            return "YES", round(conf, 2)

    # ── 5 & 6. HELLO vs STOP ──────────────────────────────────────────────
    #
    # Both have all four non-thumb fingers extended (n_up == 4).
    # They look similar to simple finger-extension checks, which is why the
    # old single-threshold rule was unreliable.
    #
    # Physical difference:
    #   HELLO: fingers fanned wide apart at angles; thumb spread away from
    #          the palm (abducted outward).
    #   STOP:  fingers parallel, held tightly together, pointing straight up;
    #          thumb rests beside/in front of the palm (not spread out).
    #
    # Two independent signals are used; both must agree.  If they disagree
    # the pose is transitional and falls through to Unknown Gesture.
    #
    # Signal A -- Adjacent fingertip spread sum (normalised):
    #   index-middle gap + middle-ring gap + ring-pinky gap.
    #   HELLO: fingers fanned  -> large sum (> 0.80 of hand scale)
    #   STOP:  fingers parallel -> small sum (< 0.55 of hand scale)
    #   Using three additive gaps is much more robust than the old single
    #   index-to-pinky measurement because one noisy frame only affects
    #   one of the three gaps.
    #
    # Signal B -- Thumb horizontal abduction (normalised):
    #   abs(THUMB_TIP.x - THUMB_MCP.x) / hand_scale.
    #   Measures how far the thumb fans laterally away from its own base.
    #   HELLO: thumb spread sideways   -> large value (> 0.30)
    #   STOP:  thumb beside palm/index -> small value (< 0.15)
    #   This is more reliable than thumb-to-index-tip distance because it
    #   only involves the thumb's own joints (no dependency on where the
    #   index finger happens to be).

    ADJACENT_HELLO  = 0.80   # adj-sum above this -> fingers are fanned (HELLO)
    ADJACENT_STOP   = 0.75   # adj-sum below this -> fingers are parallel (STOP)
    THUMB_ABD_HELLO = 0.30   # thumb abduction above this -> thumb spread (HELLO)
    THUMB_ABD_STOP  = 0.35   # thumb abduction below this -> thumb beside palm (STOP)

    if n_up == 4:
        # Signal A
        adj_sum = (
            _norm_dist(lm, INDEX_TIP,  MIDDLE_TIP, scale) +
            _norm_dist(lm, MIDDLE_TIP, RING_TIP,   scale) +
            _norm_dist(lm, RING_TIP,   PINKY_TIP,  scale)
        )

        # Signal B: horizontal distance from thumb MCP to thumb TIP
        # abs() so it works for both left and right hands
        thumb_abduction = abs(lm[THUMB_TIP].x - lm[THUMB_MCP].x) / scale

        hello_votes = 0
        stop_votes  = 0

        if adj_sum        > ADJACENT_HELLO:   hello_votes += 1
        if adj_sum        < ADJACENT_STOP:    stop_votes  += 1
        if thumb_abduction > THUMB_ABD_HELLO: hello_votes += 1
        if thumb_abduction < THUMB_ABD_STOP:  stop_votes  += 1

        if hello_votes >= 2:
            conf_adj   = min((adj_sum         - ADJACENT_HELLO)  / ADJACENT_HELLO  + 0.6, 1.0)
            conf_thumb = min((thumb_abduction  - THUMB_ABD_HELLO) / THUMB_ABD_HELLO + 0.6, 1.0)
            return "HELLO", round((conf_adj + conf_thumb) / 2, 2)

        if stop_votes >= 2:
            conf_adj   = min((ADJACENT_STOP    - adj_sum)         / ADJACENT_STOP   + 0.6, 1.0)
            conf_thumb = min((THUMB_ABD_STOP   - thumb_abduction)  / THUMB_ABD_STOP  + 0.6, 1.0)
            return "STOP", round((conf_adj + conf_thumb) / 2, 2)

        # Signals disagree -- transitional pose, do not guess

    # ── 7. Unknown ────────────────────────────────────────────────────────
    return "Unknown Gesture", 0.0
