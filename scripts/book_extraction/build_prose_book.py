"""Generic reader builder for Dubois *prose* books (systems / positional theory:
Référentiel des systèmes, Perfectionnement sens du jeu…). Unlike the D-format
exercise books these are chapters of prose with illustrative diagrams, so we
lay them out page by page: each page's prose, then the boards printed on it.

Positions are read with king detection (endgame/positional books have dames).
Where the prose gives a game/opening line that, replayed from the start, lands
exactly on a diagram, that diagram becomes steppable (◀ ▶) — same trick as the
opening manuals; nothing is invented.

Usage::

    PYTHONPATH=backend python scripts/book_extraction/build_prose_book.py <key>

where <key> is one of the entries in BOOKS below.
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
sys.path.insert(0, str(_HERE))
from board_detection import find_boards, find_boards_border_lines, _deduplicate  # noqa: E402
from fen_extraction import analyze_board_fen, validate_fen  # noqa: E402

_ROOT = _HERE.parent.parent
sys.path.insert(0, str(_ROOT / "backend"))
import game_engine as ge  # noqa: E402

BOOKS = {
    "referentiel": dict(
        pdf="docs/livres/reference/dubois_referentiel_systemes_de_jeu.pdf",
        book="Dubois — Référentiel des systèmes de jeu", level="Systèmes",
        slug="referentiel_systemes", start_page=4),
    "perf_sdj_t1": dict(
        pdf="docs/livres/perfectionnement/dubois_perfectionnement_sens_du_jeu_tome1.pdf",
        book="Dubois — Perfectionnement : le sens du jeu (t.1)", level="Perfectionnement",
        slug="perf_sens_du_jeu_t1", start_page=5),
    "perf_sdj_t2": dict(
        pdf="docs/livres/perfectionnement/dubois_perfectionnement_sens_du_jeu_tome2.pdf",
        book="Dubois — Perfectionnement : le sens du jeu (t.2)", level="Perfectionnement",
        slug="perf_sens_du_jeu_t2", start_page=5),
    "perf_sdj_t3": dict(
        pdf="docs/livres/perfectionnement/dubois_perfectionnement_sens_du_jeu_tome3.pdf",
        book="Dubois — Perfectionnement : le sens du jeu (t.3)", level="Perfectionnement",
        slug="perf_sens_du_jeu_t3", start_page=5),
}

_PIECE_BUCKET = {ge.WHITE_MAN: "wm", ge.WHITE_KING: "wk",
                 ge.BLACK_MAN: "bm", ge.BLACK_KING: "bk"}
_MOVE_TOKEN = re.compile(r"\b\d{1,2}(?:[-x]\d{1,2})+\b")
_WS = re.compile(r"[ \t]*\n[ \t]*")
_MULTISPACE = re.compile(r"[ \t]{2,}")
_CHAP = re.compile(r"Chapitre\s+(\d+)\s*[-–:]\s*([^\n]+)")


def _gray(doc, page: int) -> np.ndarray:
    pix = doc[page - 1].get_pixmap(dpi=200)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    return cv2.cvtColor(img[:, :, :3], cv2.COLOR_RGB2GRAY)


def _fen_to_start(fen: str):
    st = ge.fen_to_board(fen)
    out = {"wm": [], "wk": [], "bm": [], "bk": [], "turn": st.turn}
    for sq in range(1, 51):
        b = _PIECE_BUCKET.get(st.board[sq])
        if b:
            out[b].append(sq)
    return out


def _paras(text: str) -> list[str]:
    text = (text or "").replace("\r", "")
    out = []
    for para in re.split(r"\n[ \t]*\n", text):
        j = _MULTISPACE.sub(" ", _WS.sub(" ", para).strip())
        if j:
            out.append(j)
    return out


# --- steppable-line insertion (from prose game notation) --------------------
# A printed move sequence ("27. 28x17 11x31 28. 36x27 …") is replaced by a
# playable board that steps through it (◀ ▶). Nothing is invented: the moves
# are the book's own notation, replayed through the engine from a verified
# anchor. The anchor is found by trying, in order, the previous line's end
# (games continue across a commentary line), the diagrams of the chapter, a
# richer pool of diagrams detected on the page (multi-size — catches the small
# 3-across game diagrams the single-size pass misses), and the initial
# position. An anchor is accepted only when the printed moves replay *legally*
# from it (a wrong anchor rejects them almost immediately), so a converted line
# is engine-proof.

_MIN_PLIES = 4
# A "game span" is a run of consecutive paragraphs that each begin with a move
# number ("26…", "27.", "39…"), i.e. the printed play. Commentary is embedded
# inside those paragraphs ("… Les noirs reforment leur flèche 6-11-17 32. …"),
# so we parse plies *positionally* — only the move tokens that immediately
# follow a move number are plies; a formation like 6-11-17 sitting in the prose
# is never mistaken for a move. Each span becomes a steppable board; the
# embedded commentary is kept as prose after it.
_MOVE_START = re.compile(r"^\s*\d{1,2}\s*(?:\.\.\.|…|\.)")
_SEG = re.compile(r"\d{1,2}\s*(?:\.\.\.|…|\.)")
_PLY = re.compile(r"^\d{1,2}(?:[-x]\d{1,2})+$")
_NUM_MARK = re.compile(r"\d+\s*(?:\.\.\.|…|\.)")
_PUNCT = re.compile(r"[\s!?.,;:()«»<>\-–—…*/]")


def _text_of(b) -> str:
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
    """Plies of a game paragraph. When the paragraph is numbered, take the
    leading move tokens of each move-number segment (so prose and formations
    embedded in the notation are excluded). A number-less move paragraph
    ("17-22 !") contributes its move tokens directly."""
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
    return r if len(re.sub(r"[\s!?.,;:()«»<>\-–—…*/]", "", r)) > 3 else ""


def _state_to_start(st) -> dict:
    out = {"wm": [], "wk": [], "bm": [], "bk": [], "turn": st.turn}
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


def _anchor_states(fen: str) -> list:
    """Both side-to-move parities of a diagram FEN as candidate anchors (the
    printed 'trait' is not always captured, and only the correct parity replays)."""
    try:
        st = ge.fen_to_board(fen)
    except Exception:  # noqa: BLE001
        return []
    return [ge.GameState(board=list(st.board), turn=turn) for turn in ("white", "black")]


def _insert_steppable_lines(blocks, positions, anchors_by_ch, slug):
    """Replace each printed game span with a steppable board (◀ ▶) when its
    plies replay legally from an anchor, keeping the embedded commentary as
    prose after the board. Existing diagram positions are left untouched; new
    line boards get ``<SLUG>_line<k>`` ids.

    Acceptance is strict: the plies must replay *in full* from the anchor (a
    wrong anchor stops almost immediately), so a converted line is engine-proof
    and nothing is invented."""
    diag_by_ch: dict[int, list] = {}
    for pos in positions.values():
        for s in _anchor_states(_fen_of_start(pos["start"])):
            diag_by_ch.setdefault(pos["ch"], []).append(s)

    out, i, n, k = [], 0, len(blocks), 0
    cur_ch, prev_end = None, None
    while i < n:
        b = blocks[i]
        ch = b.get("ch")
        if ch != cur_ch:
            cur_ch, prev_end = ch, None
        if b["type"] == "p" and _is_play_block(_text_of(b)):
            j = i
            while (j < n and blocks[j].get("ch") == ch and blocks[j]["type"] == "p"
                   and _is_play_block(_text_of(blocks[j]))):
                j += 1
            span = blocks[i:j]
            plies = [p for bb in span for p in _plies(_text_of(bb))]
            # Try anchors: chain from the previous line (games continue across a
            # diagram), then this chapter's page-detected and emitted diagrams,
            # then the initial position. Require a full-length legal replay.
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


def _fen_of_start(start: dict) -> str:
    def grp(men, kings):
        return ",".join([str(s) for s in sorted(men)] + [f"K{s}" for s in sorted(kings)])
    turn = "W" if start.get("turn") == "white" else "B"
    return f"{turn}:W{grp(start['wm'], start['wk'])}:B{grp(start['bm'], start['bk'])}"


def _multi_detect(g):
    """Union of border-line detections across a size range, deduped — catches
    both the 2-across base diagrams and the smaller 3-across game diagrams."""
    allb = []
    for exp in (440, 460, 480, 500):
        allb += find_boards_border_lines(g, min_run=380, expected_px=exp, size_tolerance=0.06)
    return _deduplicate(allb)


def build(cfg: dict) -> dict:
    doc = fitz.open(str(_ROOT / cfg["pdf"]))
    n = doc.page_count
    text = [doc[i].get_text() for i in range(n)]

    # Chapters from "Chapitre N …" markers (first occurrence of each number).
    chap_marks = []
    seen = set()
    for i in range(n):
        m = _CHAP.search(text[i])
        if m and "..." not in m.group(2) and int(m.group(1)) not in seen:
            seen.add(int(m.group(1)))
            chap_marks.append((i + 1, int(m.group(1)), f"Chapitre {m.group(1)} — {m.group(2).strip()}"))
    chap_marks.sort()
    if not chap_marks:
        chap_marks = [(cfg["start_page"], 1, cfg["book"])]

    def chapter_of(page):
        num = chap_marks[0][1]
        for cp, cnum, _t in chap_marks:
            if cp <= page:
                num = cnum
            else:
                break
        return num

    chapters = [{"n": c[1], "title": c[2]} for c in chap_marks]
    blocks: list[dict] = []
    positions: dict[str, dict] = {}
    anchors_by_ch: dict[int, list] = {}
    seen_chapter_header = set()
    n_diag = 0

    for pg in range(cfg["start_page"], n + 1):
        ch = chapter_of(pg)
        if ch not in seen_chapter_header:
            title = next(c[2] for c in chap_marks if c[1] == ch)
            blocks.append({"type": "h2", "ch": ch, "runs": [{"t": title}]})
            seen_chapter_header.add(ch)
        body = re.sub(r"^\s*\d+\s*", "", text[pg - 1])
        for para in _paras(body):
            if _CHAP.match(para):  # the chapter title line already emitted as h2
                para = _CHAP.sub("", para).strip()
                if not para:
                    continue
            blocks.append({"type": "p", "ch": ch, "runs": [{"t": para}]})
        g = _gray(doc, pg)
        # Emitted diagrams: unchanged single-size detection (stable analysis material).
        for bi, (x1, y1, x2, y2) in enumerate(find_boards(g, "border_lines", 400, 505)):
            fen = analyze_board_fen(g, x1, y1, x2, y2, "W", 5, 9, 218.0, 115.0, detect_kings=True)
            ok, _ = validate_fen(fen)
            if not ok:
                continue
            try:
                start = _fen_to_start(fen)
            except Exception:  # noqa: BLE001
                continue
            pid = f"{cfg['slug'].upper()}_p{pg}_{bi}"
            positions[pid] = {"id": pid, "ch": ch, "title": f"Diagramme p. {pg}",
                              "start": start, "moves": []}
            blocks.append({"type": "board", "id": pid, "ch": ch})
            n_diag += 1
        # Anchor pool: richer multi-size detection, used only to seed steppable
        # lines (never emitted as diagrams, so the analysis material is unchanged).
        for (x1, y1, x2, y2) in _multi_detect(g):
            fen = analyze_board_fen(g, x1, y1, x2, y2, "W", 5, 9, 218.0, 115.0, detect_kings=True)
            ok, _ = validate_fen(fen)
            if ok:
                anchors_by_ch.setdefault(ch, []).extend(_anchor_states(fen))

    blocks, n_lines = _insert_steppable_lines(blocks, positions, anchors_by_ch, cfg["slug"])
    return {"book": cfg["book"], "level": cfg["level"], "chapters": chapters,
            "blocks": blocks, "positions": positions}, n_diag, n_lines


def main(argv) -> int:
    if len(argv) < 2 or argv[1] not in BOOKS:
        print(f"usage: build_prose_book.py <{'|'.join(BOOKS)}>")
        return 2
    cfg = BOOKS[argv[1]]
    data, n_diag, n_lines = build(cfg)
    out = _ROOT / "frontend/src/manuels/data" / f"{cfg['slug']}.ts"
    header = ("// Auto-generated by scripts/book_extraction/build_prose_book.py "
              "— do not edit by hand.\n"
              "import type { ManuelData } from '../ManuelInteractif'\n\n")
    out.write_text(header + f"const DATA: ManuelData = {json.dumps(data, ensure_ascii=False, indent=0)}\n\nexport default DATA\n",
                   encoding="utf-8")
    print(f"{argv[1]}: chapters={len(data['chapters'])} diagrams={n_diag} "
          f"steppable_lines={n_lines}  {out.stat().st_size // 1024} KiB -> {out.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
