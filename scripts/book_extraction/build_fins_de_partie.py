"""Extract Dubois — *Apprentissage : Fins de parties* into the ManuelInteractif
reader (prose + playable endgame boards).

Endgame diagrams are full of *dames* (kings), which the men-only FEN reader used
to miss. This uses the new ``detect_kings=True`` mode (stacked-disc detection)
so every king is read. Solutions are the book's verbatim notation, replayed
through the engine: a line that replays *in full* keeps its win verdict (guided
solve); a line that only partially replays (endgame prose is variation-heavy) is
kept as a steppable move list without a claimed verdict. Nothing is invented.

Run (repo root, backend on PYTHONPATH)::

    PYTHONPATH=backend python scripts/book_extraction/build_fins_de_partie.py
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
from board_detection import find_boards  # noqa: E402
from fen_extraction import analyze_board_fen, validate_fen  # noqa: E402

_ROOT = _HERE.parent.parent
sys.path.insert(0, str(_ROOT / "backend"))
import game_engine as ge  # noqa: E402

PDF = _ROOT / "docs/livres/apprentissage/dubois_apprendre_fins_de_partie.pdf"
OUT = _ROOT / "frontend/src/manuels/data/fins_de_partie.ts"

_PIECE_BUCKET = {ge.WHITE_MAN: "wm", ge.WHITE_KING: "wk",
                 ge.BLACK_MAN: "bm", ge.BLACK_KING: "bk"}
_MOVE = re.compile(r"\d{1,2}(?:[-x]\d{1,2})+")
_WS = re.compile(r"[ \t]*\n[ \t]*")
_MULTISPACE = re.compile(r"[ \t]{2,}")


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


def _reconstruct(fen: str, tokens: list[str]):
    st = ge.fen_to_board(fen)
    out = []
    for pdn in tokens:
        path = [int(x) for x in re.split(r"[-x]", pdn) if x]
        legal = ge.get_legal_moves(st)
        mv = next((m for m in legal if m.path == path), None)
        if mv is None:
            mv = next((m for m in legal if m.path[0] == path[0] and m.path[-1] == path[-1]), None)
        if mv is None:
            break
        f, t = mv.path[0], mv.path[-1]
        was_king = st.board[f] in (ge.WHITE_KING, ge.BLACK_KING)
        st = ge.apply_move(st, mv)
        promoted = (not was_king) and st.board[t] in (ge.WHITE_KING, ge.BLACK_KING)
        out.append({"n": pdn, "f": f, "t": t, "c": list(mv.captures),
                    "path": list(mv.path), "p": bool(promoted)})
    return out


def _paras(text: str) -> list[str]:
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
    flat = [t.replace("\n", " ") for t in text]

    chapters_raw = []
    for i in range(n):
        m = re.search(r"Chapitre\s+(\d+)\s*:\s*([^\n]+)", text[i])
        if m and "..." not in m.group(2):
            chapters_raw.append((i + 1, int(m.group(1)),
                                 f"Chapitre {m.group(1)} : {m.group(2).strip()}"))
    seen = set()
    chapters_raw = [c for c in chapters_raw if not (c[1] in seen or seen.add(c[1]))]
    ordered = sorted(chapters_raw, key=lambda c: c[1])

    def dtraits(page: int):
        return re.findall(r"D(\d+)\s*:\s*trait aux (blancs|noirs)", flat[page - 1])

    sol_pages = [i + 1 for i in range(n) if "SOLUTIONS" in text[i]]
    blocks = []
    for s in sol_pages:
        expgs = [p for p in (s - 2, s - 1) if dtraits(p)]
        if expgs:
            blocks.append((expgs, s))

    def chapter_of(page: int) -> int:
        num = ordered[0][1]
        for (cp, cnum, _t) in ordered:
            if cp <= page:
                num = cnum
            else:
                break
        return num

    positions: dict[str, dict] = {}
    boards_by_chapter: dict[int, list[str]] = {}
    n_diag = n_full = n_partial = 0

    for expgs, s in blocks:
        chap = chapter_of(expgs[0])
        traits = {}
        for p in expgs:
            for d, side in dtraits(p):
                traits[int(d)] = "W" if side == "blancs" else "B"
        parts = re.split(r"\bD(\d+)\s*:", text[s - 1])
        sols = {int(parts[k]): parts[k + 1] for k in range(1, len(parts), 2)}
        dnum = 0
        for p in expgs:
            g = _gray(doc, p)
            for (x1, y1, x2, y2) in find_boards(g, "border_lines", 400, 505):
                dnum += 1
                tm = traits.get(dnum, "W")
                fen = analyze_board_fen(g, x1, y1, x2, y2, tm, 5, 9, 218.0, 115.0,
                                        detect_kings=True)
                ok, _ = validate_fen(fen)
                if not ok:
                    continue
                try:
                    ge.fen_to_board(fen)
                except Exception:  # noqa: BLE001
                    continue
                pid = f"FDP_s{s}_D{dnum}"
                pos = {"id": pid, "ch": chap, "title": f"Diagramme {dnum}",
                       "start": _fen_to_start(fen), "moves": []}
                soltext = sols.get(dnum, "")
                toks = _MOVE.findall(re.sub(r"\[[^\]]*\]", " ", soltext))
                moves = _reconstruct(fen, toks) if toks else []
                if len(moves) >= 2:
                    pos["moves"] = moves
                    pos["pub"] = " ".join(m["n"] for m in moves)
                    # Full replay → a trustworthy solve; partial → step-only.
                    if len(moves) == len(toks):
                        pos["win"] = "white" if tm == "W" else "black"
                        n_full += 1
                    else:
                        n_partial += 1
                    comment = _MOVE.sub("", re.sub(r"Solution\s*:", "", soltext))
                    comment = _MULTISPACE.sub(" ", _WS.sub(" ", comment)).strip(" .()[]\n")
                    if len(comment) > 8:
                        pos["exp"] = comment[:400]
                positions[pid] = pos
                boards_by_chapter.setdefault(chap, []).append(pid)
                n_diag += 1

    chapters = [{"n": 0, "title": "Présentation"}]
    blocks_out = [
        {"type": "h1", "ch": 0, "runs": [{"t": "Apprendre les fins de partie"}]},
        {"type": "p", "ch": 0, "runs": [{"t": "J-P. Dubois. Chaque chapitre présente un "
            "thème de finale, puis des diagrammes à jouer (dames incluses)."}]},
    ]
    for idx, (cp, cnum, title) in enumerate(ordered):
        end = ordered[idx + 1][0] if idx + 1 < len(ordered) else cp + 3
        prose = []
        for pg in range(cp, min(end, cp + 3)):
            body = re.sub(r"^\s*\d+\s*", "", text[pg - 1])
            if "SOLUTIONS" in body or re.search(r"D\d+\s*:\s*trait", body):
                continue
            prose += _paras(body)
        chapters.append({"n": cnum, "title": title})
        blocks_out.append({"type": "h2", "ch": cnum, "runs": [{"t": title}]})
        for para in prose[:16]:
            blocks_out.append({"type": "p", "ch": cnum, "runs": [{"t": para}]})
        bids = boards_by_chapter.get(cnum, [])
        if bids:
            blocks_out.append({"type": "h3", "ch": cnum, "runs": [{"t": "Diagrammes"}]})
            for pid in bids:
                blocks_out.append({"type": "board", "id": pid, "ch": cnum})

    data = {"book": "Dubois — Apprendre les fins de partie", "level": "Finales",
            "chapters": chapters, "blocks": blocks_out, "positions": positions}
    header = ("// Auto-generated by scripts/book_extraction/build_fins_de_partie.py "
              "— do not edit by hand.\n"
              "import type { ManuelData } from '../ManuelInteractif'\n\n")
    OUT.write_text(header + f"const DATA: ManuelData = {json.dumps(data, ensure_ascii=False, indent=0)}\n\nexport default DATA\n",
                   encoding="utf-8")
    print(f"chapters={len(chapters)} diagrams={n_diag} solvable(full)={n_full} "
          f"step-only(partial)={n_partial}  {OUT.stat().st_size // 1024} KiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
