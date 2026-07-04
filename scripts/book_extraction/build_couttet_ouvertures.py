"""Extract Couttet — *Étude des ouvertures* into the ManuelInteractif reader.

This book has NO diagrams: it is pure opening analysis (25 « Débuts » listed in
the page-2 répertoire, each with its opening move, the reply, and its start
page). The reader is therefore prose-first, with engine-derived boards:

  - every chapter opens with its two-ply opening position (the répertoire's
    Ouvert./Répons. columns replayed from the initial position) — steppable;
  - when the chapter's *main line* (the numbered pure-notation lines, strictly
    replayed from the initial position) stays legal for ≥6 plies, a second board
    shows the position after that line, steppable move by move.

Everything shown is either the book's verbatim notation or an engine replay of
it — a line whose transcription is polluted by the two-column layout simply
stops at its last legal ply (nothing is guessed).

Run (repo root)::

    PYTHONPATH=backend python scripts/book_extraction/build_couttet_ouvertures.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import fitz  # type: ignore

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent.parent
sys.path.insert(0, str(_ROOT / "backend"))
import game_engine as ge  # noqa: E402
from strategy.steppable_lines import insert_steppable_lines  # noqa: E402

PDF = _ROOT / "docs/livres/reference/couttet_etude_des_ouvertures.pdf"
OUT = _ROOT / "frontend/src/manuels/data/couttet_ouvertures.ts"

_PIECE_BUCKET = {ge.WHITE_MAN: "wm", ge.WHITE_KING: "wk",
                 ge.BLACK_MAN: "bm", ge.BLACK_KING: "bk"}
_TOK = re.compile(r"\b\d{1,2}(?:\s*[-x]\s*\d{1,2})+\b")
_WS = re.compile(r"[ \t]*\n[ \t]*")
_MULTISPACE = re.compile(r"[ \t]{2,}")


def _start_of(st) -> dict:
    out = {"wm": [], "wk": [], "bm": [], "bk": [], "turn": st.turn}
    for sq in range(1, 51):
        b = _PIECE_BUCKET.get(st.board[sq])
        if b:
            out[b].append(sq)
    return out


def _replay(tokens: list[str]):
    """Strict replay from the initial position; stops at the first token that is
    not a legal move. Returns (viewer moves, plies)."""
    st = ge.initial_state()
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
    return moves


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

    # Répertoire (page 2): N(er|e) Début / title / opening / reply / start page.
    lines = [ln.strip() for ln in text[1].split("\n") if ln.strip()]
    entries = []  # (num, title, open, reply, page)
    for i, ln in enumerate(lines):
        m = re.match(r"^(\d+)\s*(?:er|e|ème)\s*D[ée]but$", ln)
        if not m:
            continue
        # Title may wrap over several TOC lines: gather until the opening move.
        j = i + 1
        title_parts = []
        while j < len(lines) and not _TOK.fullmatch(lines[j].replace(" ", "")):
            title_parts.append(lines[j])
            j += 1
            if len(title_parts) > 3:
                break
        if j + 2 < len(lines) and _TOK.fullmatch(lines[j].replace(" ", "")) \
                and _TOK.fullmatch(lines[j + 1].replace(" ", "")) and lines[j + 2].isdigit():
            entries.append((int(m.group(1)), " ".join(title_parts),
                            lines[j].replace(" ", ""), lines[j + 1].replace(" ", ""),
                            int(lines[j + 2])))
    entries.sort(key=lambda e: (e[4], e[0]))

    chapters = [{"n": 0, "title": "Introduction"}]
    blocks: list[dict] = [
        {"type": "h1", "ch": 0, "runs": [{"t": "Étude des ouvertures"}]},
        {"type": "p", "ch": 0, "runs": [{"t": "Adrien Couttet. 25 débuts analysés ; "
            "chaque chapitre s'ouvre sur la position d'ouverture jouable, et la "
            "ligne principale est déroulable quand elle se rejoue entièrement."}]},
    ]
    positions: dict[str, dict] = {}
    for para in _paras(re.sub(r"^\s*\d+\s*", "", text[0])):
        blocks.append({"type": "p", "ch": 0, "runs": [{"t": para}]})

    n_boards = 0
    for idx, (num, title, mopen, mreply, pg) in enumerate(entries):
        end_pg = entries[idx + 1][4] if idx + 1 < len(entries) else n + 1
        ch = num
        chapters.append({"n": ch, "title": f"{num}. {title}"})
        blocks.append({"type": "h2", "ch": ch, "runs": [{"t": f"{num}e Début — {title}"}]})

        # Opening board: the répertoire's two plies from the initial position.
        opening = _replay([mopen, mreply])
        if len(opening) == 2:
            pid = f"COUTTET_d{num}_open"
            positions[pid] = {"id": pid, "ch": ch, "title": f"Ouverture {mopen} {mreply}",
                              "theme": title[:40],
                              "start": _start_of(ge.initial_state()), "moves": opening,
                              "pub": f"{mopen} {mreply}"}
            blocks.append({"type": "board", "id": pid, "ch": ch})
            n_boards += 1

        # Chapter prose: the numbered move-lists are laid out as text here, then
        # turned into steppable boards by the shared pass below (which supersedes
        # the old single end-of-line board — the lines now step inline).
        for p in range(pg, min(end_pg, n + 1)):
            body = re.sub(r"^\s*\d+\s*", "", text[p - 1])
            for para in _paras(body):
                blocks.append({"type": "p", "ch": ch, "runs": [{"t": para}]})

    # Replace the printed opening lines with steppable boards (◀ ▶), engine-
    # verified from the initial position or the previous line's end.
    blocks, n_lines = insert_steppable_lines(blocks, positions, {}, "couttet_ouvertures")
    n_boards += n_lines

    data = {"book": "Couttet — Étude des ouvertures", "level": "Ouvertures",
            "chapters": chapters, "blocks": blocks, "positions": positions}
    header = ("// Auto-generated by scripts/book_extraction/build_couttet_ouvertures.py "
              "— do not edit by hand.\n"
              "import type { ManuelData } from '../ManuelInteractif'\n\n")
    OUT.write_text(header + f"const DATA: ManuelData = {json.dumps(data, ensure_ascii=False, indent=0)}\n\nexport default DATA\n",
                   encoding="utf-8")
    print(f"chapters={len(chapters)} boards={n_boards} (steppable lines={n_lines}) "
          f"{OUT.stat().st_size // 1024} KiB -> {OUT.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
