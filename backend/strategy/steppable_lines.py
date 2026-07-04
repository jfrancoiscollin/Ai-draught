"""Turn printed game notation in a reader into steppable boards.

The prose books/manuals print games as long move lists ("27. 28x17 11x31
28. 36x27 …"). This post-pass replaces each such *game span* with a playable
board that steps through the line (◀ ▶ in ``ManuelInteractif``). Nothing is
invented: the moves are the book's own notation, replayed through the engine
from a verified anchor, and a span is converted only when **every** ply replays
legally (a wrong anchor stops almost immediately).

Builder-agnostic: it operates on the assembled ``blocks`` + ``positions`` of any
reader. Anchors come from (a) the end of the previous line — games continue past
a diagram, (b) extra per-chapter anchor states the caller supplies (e.g. from a
richer multi-size diagram detection), (c) the reader's own diagram positions,
and (d) the initial position. Existing diagram positions are never mutated; new
line boards get ``<SLUG>_line<k>`` ids so downstream consumers can ignore them.
"""
from __future__ import annotations

import re
from typing import Any

import game_engine as ge

_PIECE_BUCKET = {ge.WHITE_MAN: "wm", ge.WHITE_KING: "wk",
                 ge.BLACK_MAN: "bm", ge.BLACK_KING: "bk"}

_MOVE_TOKEN = re.compile(r"\b\d{1,2}(?:[-x]\d{1,2})+\b")
_MOVE_START = re.compile(r"^\s*\d{1,2}\s*(?:\.\.\.|…|\.)")
_SEG = re.compile(r"\d{1,2}\s*(?:\.\.\.|…|\.)")
_PLY = re.compile(r"^\d{1,2}(?:[-x]\d{1,2})+$")
_NUM_MARK = re.compile(r"\d+\s*(?:\.\.\.|…|\.)")
_PUNCT = re.compile(r"[\s!?.,;:()«»<>\-–—…*/]")
_MULTISPACE = re.compile(r"\s{2,}")

_MIN_PLIES = 4


def _text_of(b: dict) -> str:
    return "".join(r.get("t", "") for r in b.get("runs", []))


def _is_pure_move(t: str) -> bool:
    """A paragraph that is (almost) only moves + move numbers — "17-22 !",
    "27. 28x17 11x31" — even when it carries no move number of its own."""
    if not _MOVE_TOKEN.search(t):
        return False
    res = _NUM_MARK.sub(" ", _MOVE_TOKEN.sub(" ", t))
    return len(_PUNCT.sub("", res)) <= 2


def _is_play_block(t: str) -> bool:
    """Part of a printed game span: starts with a move number ("27.", "39…")
    or is a number-less move paragraph ("17-22 !")."""
    return bool(_MOVE_TOKEN.search(t)) and (bool(_MOVE_START.match(t)) or _is_pure_move(t))


def _plies(text: str) -> list[str]:
    """Plies of a game paragraph. When numbered, take the leading move tokens of
    each move-number segment (so prose and formations embedded in the notation
    are excluded). A number-less move paragraph contributes its move tokens."""
    if not _SEG.search(text):
        return [w for w in text.split() if _PLY.match(w)] if _is_pure_move(text) else []
    plies: list[str] = []
    for seg in _SEG.split(text)[1:]:  # markers dropped
        for w in seg.strip().split():
            if _PLY.match(w):
                plies.append(w)
            else:
                break
    return plies


def _prose_residual(text: str) -> str:
    """The commentary left once move numbers and move tokens are removed."""
    r = _MOVE_TOKEN.sub(" ", _SEG.sub(" ", text))
    r = _MULTISPACE.sub(" ", r).strip(" .!?,;:—–-")
    return r if len(_PUNCT.sub("", r)) > 3 else ""


def _state_to_start(st) -> dict:
    out: dict[str, Any] = {"wm": [], "wk": [], "bm": [], "bk": [], "turn": st.turn}
    for sq in range(1, 51):
        b = _PIECE_BUCKET.get(st.board[sq])
        if b:
            out[b].append(sq)
    return out


def _replay_line(anchor, plies):
    """Replay plies from ``anchor`` until one is illegal. Returns (moves, end,
    consumed) — a wrong anchor consumes ~0, the correct one consumes them all."""
    st = anchor.copy()
    moves = []
    for pdn in plies:
        path = [int(x) for x in re.split(r"[-x]", pdn) if x]
        legal = ge.get_legal_moves(st)
        mv = next((m for m in legal if m.path == path), None) or \
            next((m for m in legal if m.path[0] == path[0] and m.path[-1] == path[-1]), None)
        if mv is None:
            break
        f, t = mv.path[0], mv.path[-1]
        was_king = st.board[f] in (ge.WHITE_KING, ge.BLACK_KING)
        st = ge.apply_move(st, mv)
        promoted = (not was_king) and st.board[t] in (ge.WHITE_KING, ge.BLACK_KING)
        moves.append({"n": pdn, "f": f, "t": t, "c": list(mv.captures),
                      "path": list(mv.path), "p": bool(promoted)})
    return moves, st, len(moves)


def _fen_of_start(start: dict) -> str:
    def grp(men, kings):
        return ",".join([str(s) for s in sorted(men)] + [f"K{s}" for s in sorted(kings)])
    turn = "W" if start.get("turn") == "white" else "B"
    return f"{turn}:W{grp(start['wm'], start['wk'])}:B{grp(start['bm'], start['bk'])}"


def anchor_states(fen: str) -> list:
    """Both side-to-move parities of a diagram FEN as candidate anchors (the
    printed 'trait' is not always captured, and only the correct parity replays)."""
    try:
        st = ge.fen_to_board(fen)
    except Exception:  # noqa: BLE001
        return []
    return [ge.GameState(board=list(st.board), turn=turn) for turn in ("white", "black")]


def insert_steppable_lines(blocks, positions, anchors_by_ch=None, slug=""):
    """Replace each printed game span with a steppable board when its plies
    replay in full from an anchor, keeping the embedded commentary as prose
    after the board. Returns (new_blocks, n_lines)."""
    anchors_by_ch = anchors_by_ch or {}
    diag_by_ch: dict[int, list] = {}
    for pos in positions.values():
        for s in anchor_states(_fen_of_start(pos["start"])):
            diag_by_ch.setdefault(pos["ch"], []).append(s)

    out, i, n, k = [], 0, len(blocks), 0
    cur_ch, prev_end = None, None
    while i < n:
        b = blocks[i]
        ch = b.get("ch")
        if ch != cur_ch:
            cur_ch, prev_end = ch, None
        if b.get("type") == "p" and _is_play_block(_text_of(b)):
            j = i
            while (j < n and blocks[j].get("ch") == ch and blocks[j].get("type") == "p"
                   and _is_play_block(_text_of(blocks[j]))):
                j += 1
            span = blocks[i:j]
            plies = [p for bb in span for p in _plies(_text_of(bb))]
            cands = ([prev_end] if prev_end is not None else []) \
                + anchors_by_ch.get(ch, []) + diag_by_ch.get(ch, []) + [ge.initial_state()]
            best = None
            for a in cands:
                mv, end, used = _replay_line(a, plies)
                if used == len(plies) and used >= _MIN_PLIES:
                    best = (mv, end, a)
                    break
            if best:
                mv, end, a = best
                pid = f"{slug.upper()}_line{k}"
                k += 1
                positions[pid] = {"id": pid, "ch": ch, "title": "Séquence de la partie",
                                  "start": _state_to_start(a), "moves": mv,
                                  "pub": " ".join(m["n"] for m in mv)}
                out.append({"type": "board", "id": pid, "ch": ch})
                for bb in span:  # keep the commentary embedded in the notation
                    res = _prose_residual(_text_of(bb))
                    if res:
                        out.append({"type": "p", "ch": ch, "runs": [{"t": res}]})
                prev_end = end
                i = j
                continue
            prev_end = None
            out.extend(span)
            i = j
            continue
        out.append(b)
        i += 1
    return out, k
