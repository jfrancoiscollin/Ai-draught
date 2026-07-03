"""
Extract FEN strings from board images.

International draughts uses squares 1-50 on a 10×10 board.
Only dark squares are used; they are numbered left-to-right, top-to-bottom:
  row 0 (top): squares 1-5
  row 1      : squares 6-10
  ...
  row 9 (bot): squares 46-50

For even rows (0, 2, …) the dark squares are in columns 1,3,5,7,9.
For odd rows  (1, 3, …) the dark squares are in columns 0,2,4,6,8.
"""
from __future__ import annotations
from typing import Tuple, List, Optional

import numpy as np


def sq_number(row: int, col: int) -> Optional[int]:
    """Return the square number (1-50) for a (row, col) cell, or None for light squares."""
    if (row + col) % 2 == 0:
        return None      # light square, not used
    return row * 5 + col // 2 + 1


def analyze_board_fen(
    gray: np.ndarray,
    x1: int, y1: int, x2: int, y2: int,
    to_move: str = 'W',
    margin_px: int = 5,
    sample_radius: int = 9,
    white_threshold: float = 218.0,
    black_threshold: float = 115.0,
    detect_kings: bool = False,
    king_vext_threshold: float = 0.83,
) -> str:
    """
    Sample every dark square of the board and classify it as white piece,
    black piece, or empty.  Returns an FEN string like:
        W:W25,32,33:B14,19
    With ``detect_kings=True`` a stacked disc (a *dame*) is recognised and the
    square is prefixed ``K`` (e.g. ``W:W25,K33:B14`` — needed for endgame books).

    Parameters
    ----------
    gray            grayscale image array (float32 or uint8)
    x1,y1,x2,y2    board pixel bounding box (including border lines)
    to_move         'W' or 'B'
    margin_px       pixels to skip inside the border before computing the grid
    sample_radius   half-width of the square sample (r × r pixel patch)
    white_threshold center mean > this → white piece on square
    black_threshold center mean < this → black piece on square
    detect_kings    classify men vs kings by piece height (Dubois stacked disc)
    king_vext_threshold  piece vertical extent (fraction of the square) above
                    which the disc is a king; men ≈ 0.7, kings ≈ 0.9
    """
    if detect_kings:
        return _analyze_with_kings(gray, x1, y1, x2, y2, to_move,
                                   white_threshold, black_threshold, king_vext_threshold)

    # Inner board (exclude border lines)
    x1i = x1 + margin_px
    y1i = y1 + margin_px
    bw = (x2 - x1) - 2 * margin_px
    bh = (y2 - y1) - 2 * margin_px
    sq_w = bw / 10.0
    sq_h = bh / 10.0

    white_sqs: List[int] = []
    black_sqs: List[int] = []

    for row in range(10):
        for col in range(10):
            sq = sq_number(row, col)
            if sq is None:
                continue
            cx = int(x1i + (col + 0.5) * sq_w)
            cy = int(y1i + (row + 0.5) * sq_h)
            r = sample_radius
            y0 = max(0, cy - r)
            y1c = min(gray.shape[0], cy + r)
            x0 = max(0, cx - r)
            x1c = min(gray.shape[1], cx + r)
            patch = gray[y0:y1c, x0:x1c]
            if patch.size == 0:
                continue
            cv = float(patch.mean())
            if cv > white_threshold:
                white_sqs.append(sq)
            elif cv < black_threshold:
                black_sqs.append(sq)

    w_part = ','.join(str(s) for s in sorted(white_sqs))
    b_part = ','.join(str(s) for s in sorted(black_sqs))
    return f'{to_move}:W{w_part}:B{b_part}'


def _analyze_with_kings(
    gray: np.ndarray, x1: int, y1: int, x2: int, y2: int, to_move: str,
    white_threshold: float, black_threshold: float, king_vext: float,
) -> str:
    """FEN extraction that also tells men from kings by the disc *height*.

    A Dubois man is a single disc; a *dame* is a stack of discs, so its
    silhouette is markedly taller. We measure the vertical extent of the
    high-contrast (fill + outline) pixels in the square's central band and call
    it a king when that extent exceeds ``king_vext`` of the square.
    """
    sq_w = (x2 - x1) / 10.0
    sq_h = (y2 - y1) / 10.0
    men_w: List[int] = []
    men_b: List[int] = []
    kings_w: List[int] = []
    kings_b: List[int] = []
    m = 0.16  # inner margin (skip the grid lines)
    for row in range(10):
        for col in range(10):
            sq = sq_number(row, col)
            if sq is None:
                continue
            cy0 = y1 + row * sq_h
            cx0 = x1 + col * sq_w
            iy0, iy1 = int(cy0 + m * sq_h), int(cy0 + (1 - m) * sq_h)
            ix0, ix1 = int(cx0 + m * sq_w), int(cx0 + (1 - m) * sq_w)
            inner = gray[iy0:iy1, ix0:ix1].astype(int)
            h, w = inner.shape
            if h < 6 or w < 6:
                continue
            band = inner[:, int(w * 0.30):int(w * 0.70)]
            mask = (band > white_threshold) | (band < black_threshold)
            rows = np.where(mask.mean(axis=1) > 0.15)[0]
            if len(rows) < 2:
                continue
            vext = (rows[-1] - rows[0] + 1) / h
            if vext < 0.35:  # not a disc, just noise
                continue
            bright = float((inner > 210).mean())
            dark = float((inner < 95).mean())
            is_white = bright >= dark
            is_king = vext > king_vext
            if is_white:
                (kings_w if is_king else men_w).append(sq)
            else:
                (kings_b if is_king else men_b).append(sq)

    def grp(men: List[int], kings: List[int]) -> str:
        return ','.join([str(s) for s in sorted(men)]
                        + [f'K{s}' for s in sorted(kings)])
    return f'{to_move}:W{grp(men_w, kings_w)}:B{grp(men_b, kings_b)}'


def validate_fen(fen: str) -> Tuple[bool, str]:
    """
    Basic FEN sanity check.  Returns (ok, reason).

    Checks:
    - Correct format  X:WA,B,...:CB,...
    - All square numbers in 1-50
    - No square appears twice
    - At least one piece on each side
    """
    import re
    m = re.match(r'^([WB]):W([K\d,]*):B([K\d,]*)$', fen)
    if not m:
        return False, f'Format mismatch: {fen!r}'
    to_move, w_str, b_str = m.group(1), m.group(2), m.group(3)

    def parse_squares(s: str) -> List[int]:
        # squares may be king-prefixed (e.g. "K33") in endgame extraction
        return [int(x.lstrip('K')) for x in s.split(',') if x]

    white = parse_squares(w_str)
    black = parse_squares(b_str)

    all_sq = white + black
    for sq in all_sq:
        if not 1 <= sq <= 50:
            return False, f'Square {sq} out of range'
    if len(all_sq) != len(set(all_sq)):
        return False, 'Duplicate squares detected'
    if not white:
        return False, 'No white pieces'
    if not black:
        return False, 'No black pieces'
    return True, 'ok'
