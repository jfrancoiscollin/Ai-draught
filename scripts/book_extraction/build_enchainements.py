"""Extract Grégoire/Pesente — *Les enchaînements* into the ManuelInteractif
reader (prose + playable boards).

This book uses a diagram style none of the existing detectors handled: a small
grid of light-gray/white cells with pieces drawn as filled (black) or outlined
(white) discs on the gray playing squares. Detection here fits the board grid on
the *lattice of gray-cell centroids* (50 per board), which also yields the cell
size exactly; pieces are then classified by centre brightness.

Verification: the book precedes most diagrams with the numbered move line that
produces them. Replaying those lines from the initial position and landing
exactly on the extracted FEN both (a) cross-checks the pixel extraction against
the engine and (b) makes the diagram steppable (◀ ▶) in the reader. The
calibration diagram (13) was verified square-for-square this way.

Run (repo root)::

    PYTHONPATH=backend python scripts/book_extraction/build_enchainements.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import fitz  # type: ignore
import numpy as np  # type: ignore
import cv2  # type: ignore

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent.parent
sys.path.insert(0, str(_ROOT / "backend"))
import game_engine as ge  # noqa: E402

PDF = _ROOT / "docs/livres/reference/les_enchainements.pdf"
OUT = _ROOT / "frontend/src/manuels/data/enchainements.ts"

_PIECE_BUCKET = {ge.WHITE_MAN: "wm", ge.WHITE_KING: "wk",
                 ge.BLACK_MAN: "bm", ge.BLACK_KING: "bk"}
# The print spaces digits inside a move ("( 1- 7)"), so allow inner whitespace
# and normalise tokens by stripping it.
_MOVE_TOKEN = re.compile(r"\b\d{1,2}(?:\s*[-x]\s*\d{1,2})+\b")


def _norm_tok(t: str) -> str:
    return re.sub(r"\s+", "", t)
_WS = re.compile(r"[ \t]*\n[ \t]*")
_MULTISPACE = re.compile(r"[ \t]{2,}")


# --- board detection: gray-cell lattice --------------------------------------
def _find_boards(g: np.ndarray):
    """Boards as (grid_x0, grid_y0, cell_w, cell_h): centre of cell (0,0) and
    cell pitch, fitted on the centroids of the 50 gray playing squares."""
    mask = ((g >= 185) & (g <= 198)).astype(np.uint8)
    big = cv2.dilate(mask, np.ones((25, 25), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(big, 8)
    out = []
    for i in range(1, n):
        w, h = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        if not (300 < w < 620 and 300 < h < 620 and 0.75 < w / h < 1.35):
            continue
        x, y = stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP]
        region = (labels[y:y + h, x:x + w] == i) & (mask[y:y + h, x:x + w] > 0)
        sub = region.astype(np.uint8)
        cn, clab, cstats, ccent = cv2.connectedComponentsWithStats(sub, 8)
        cells = [(ccent[j][0] + x, ccent[j][1] + y) for j in range(1, cn)
                 if 400 < cstats[j, cv2.CC_STAT_AREA] < 4000]
        if len(cells) < 40:  # a real board shows ~50 gray cells
            continue

        def cluster(vals, tol=8.0):
            groups = []
            for v in sorted(vals):
                if groups and v - groups[-1][-1] < tol:
                    groups[-1].append(v)
                else:
                    groups.append([v])
            return [sum(c) / len(c) for c in groups]
        cx = cluster([c[0] for c in cells])
        cy = cluster([c[1] for c in cells])
        if len(cx) != 10 or len(cy) != 10:
            continue
        cw = float(np.median(np.diff(cx)))
        ch = float(np.median(np.diff(cy)))
        out.append((cx[0], cy[0], cw, ch))
    return sorted(out, key=lambda b: (b[1], b[0]))


def _read_fen(g: np.ndarray, board, to_move: str = "W"):
    """Classify each playing square by its centre brightness: black disc < 100,
    white disc (bright fill) > 235, empty gray ≈ 191."""
    x0, y0, cw, ch = board
    W, B = [], []
    for r in range(10):
        for c in range(10):
            if (r + c) % 2 != 1:
                continue
            sq = r * 5 + (c // 2) + 1
            ccx, ccy = x0 + c * cw, y0 + r * ch
            patch = g[int(ccy - 5):int(ccy + 5), int(ccx - 5):int(ccx + 5)]
            if patch.size == 0:
                continue
            m = float(patch.mean())
            if m < 100:
                B.append(sq)
            elif m > 235:
                W.append(sq)
    if not W or not B:
        return None
    return f"{to_move}:W{','.join(map(str, W))}:B{','.join(map(str, B))}"


# --- engine helpers -----------------------------------------------------------
def _fen_to_start(fen: str):
    st = ge.fen_to_board(fen)
    out = {"wm": [], "wk": [], "bm": [], "bk": [], "turn": st.turn}
    for sq in range(1, 51):
        b = _PIECE_BUCKET.get(st.board[sq])
        if b:
            out[b].append(sq)
    return out


def _state_from_start(start):
    board = [ge.EMPTY] * 51
    for s in start["wm"]:
        board[s] = ge.WHITE_MAN
    for s in start["bm"]:
        board[s] = ge.BLACK_MAN
    return ge.GameState(board=board, turn=start["turn"])


def _key(st):
    return (st.turn, tuple(st.board[1:51]))


def _replay_until(start_state, tokens, targets):
    """Replay tokens; stop when the board matches one of ``targets`` (a dict of
    key → both turn variants accepted, since the diagram's side to move is not
    printed). Returns (moves, end_state, matched_key)."""
    st = start_state.copy()
    moves = []
    for pdn in tokens:
        path = [int(x) for x in re.split(r"[-x]", pdn) if x]
        legal = ge.get_legal_moves(st)
        mv = next((m for m in legal if m.path == path), None)
        if mv is None:
            mv = next((m for m in legal if m.path[0] == path[0] and m.path[-1] == path[-1]), None)
        if mv is None:
            break
        f, t = mv.path[0], mv.path[-1]
        st = ge.apply_move(st, mv)
        moves.append({"n": pdn, "f": f, "t": t, "c": list(mv.captures),
                      "path": list(mv.path), "p": False})
        if len(moves) >= 2 and tuple(st.board[1:51]) in targets:
            return moves, st, tuple(st.board[1:51])
    return None, None, None


def _paras(text: str):
    text = (text or "").replace("\r", "")
    out = []
    for para in re.split(r"\n[ \t]*\n", text):
        j = _MULTISPACE.sub(" ", _WS.sub(" ", para).strip())
        if j:
            out.append(j)
    return out


def main() -> int:
    doc = fitz.open(str(PDF))
    n = doc.page_count
    text = [doc[i].get_text() for i in range(n)]

    # Sections from the page-2 table of contents, located in the body.
    toc = [ln.strip() for ln in text[1].split("\n")
           if ln.strip() and not ln.strip().startswith("Page")
           and ln.strip() != "Les enchaînements"]
    sections = []  # (page, num, title)
    for num, title in enumerate(toc, start=1):
        probe = title[:24]
        for i in range(2, n):
            if probe in text[i]:
                sections.append((i + 1, num, title))
                break
    sections.sort(key=lambda s: (s[0], s[1]))
    if not sections:
        sections = [(3, 1, "Les enchaînements")]

    def chapter_of(page):
        num = sections[0][1]
        for cp, cnum, _t in sections:
            if cp <= page:
                num = cnum
            else:
                break
        return num

    chapters = [{"n": s[1], "title": s[2]} for s in sections]
    blocks: list[dict] = []
    positions: dict[str, dict] = {}
    emitted_h2 = set()
    n_diag = 0

    for pg in range(3, n + 1):
        ch = chapter_of(pg)
        if ch not in emitted_h2:
            blocks.append({"type": "h2", "ch": ch, "runs": [
                {"t": next(s[2] for s in sections if s[1] == ch)}]})
            emitted_h2.add(ch)
        body = re.sub(r"Page \d+\s*$", "", text[pg - 1])
        for para in _paras(body):
            blocks.append({"type": "p", "ch": ch, "runs": [{"t": para}]})
        pix = doc[pg - 1].get_pixmap(dpi=200)
        g = cv2.cvtColor(np.frombuffer(pix.samples, dtype=np.uint8)
                         .reshape(pix.height, pix.width, pix.n)[:, :, :3],
                         cv2.COLOR_RGB2GRAY)
        for bi, board in enumerate(_find_boards(g)):
            fen = _read_fen(g, board)
            if not fen:
                continue
            try:
                start = _fen_to_start(fen)
            except Exception:  # noqa: BLE001
                continue
            pid = f"ENCH_p{pg}_{bi}"
            positions[pid] = {"id": pid, "ch": ch, "title": f"Diagramme p. {pg}",
                              "start": start, "moves": []}
            blocks.append({"type": "board", "id": pid, "ch": ch})
            n_diag += 1

    # Steppable lines: the numbered line before a diagram replays onto it.
    # The board's side to move is unknown from pixels, so match board-only.
    by_ch: dict[int, list] = {}
    for b in blocks:
        by_ch.setdefault(b["ch"], []).append(b)
    attached = 0
    for blist in by_ch.values():
        tokens = []
        prev_end = None
        for b in blist:
            if b["type"] in ("p", "h2"):
                for run in b.get("runs", []):
                    tokens += [_norm_tok(m.group(0)) for m in _MOVE_TOKEN.finditer(run.get("t", ""))]
            elif b["type"] == "board":
                pos = positions[b["id"]]
                target_board = tuple(_state_from_start(pos["start"]).board[1:51])
                found = None
                if not pos["moves"] and tokens:
                    # Analysis variations pollute the buffer anywhere around the
                    # real line, so try the replay from every token offset (the
                    # buffers are short; this is cheap and exact).
                    for s in [ge.initial_state()] + ([prev_end] if prev_end else []):
                        for start_idx in range(len(tokens)):
                            mv, end, _hit = _replay_until(s, tokens[start_idx:], {target_board})
                            if mv:
                                found = (s, mv, end)
                                break
                        if found:
                            break
                if found:
                    s, mv, end = found
                    out = {"wm": [], "wk": [], "bm": [], "bk": [], "turn": s.turn}
                    for sq in range(1, 51):
                        bk = _PIECE_BUCKET.get(s.board[sq])
                        if bk:
                            out[bk].append(sq)
                    pos["start"] = out
                    pos["moves"] = mv
                    pos["pub"] = " ".join(m["n"] for m in mv)
                    prev_end = end
                    attached += 1
                else:
                    prev_end = _state_from_start(pos["start"])
                tokens = []

    data = {"book": "Grégoire — Les enchaînements", "level": "Stratégie",
            "chapters": chapters, "blocks": blocks, "positions": positions}
    header = ("// Auto-generated by scripts/book_extraction/build_enchainements.py "
              "— do not edit by hand.\n"
              "import type { ManuelData } from '../ManuelInteractif'\n\n")
    OUT.write_text(header + f"const DATA: ManuelData = {json.dumps(data, ensure_ascii=False, indent=0)}\n\nexport default DATA\n",
                   encoding="utf-8")
    print(f"chapters={len(chapters)} diagrams={n_diag} steppable={attached} "
          f"{OUT.stat().st_size // 1024} KiB -> {OUT.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
