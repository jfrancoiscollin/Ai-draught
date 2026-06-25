"""Assemble each strategic manual into the self-contained *interactive manual*
DATA used by the frontend ``ManuelInteractif`` viewer.

The viewer (``frontend/src/manuels/ManuelInteractif.tsx``) consumes the same
``DATA = {book, level, chapters, blocks, positions}`` schema introduced by the
hand-built *manuel Débutant* (Dubois). This generator produces one such object
per corpus source, reusing the *already tested* manual-assembly logic in
``strategy/api.py`` (prose grouping, theme chapters, diagram FENs, verified
solution lines) so nothing is re-derived or invented:

  - prose books (Sijbrands, Springer, Roozenburg, Keller) -> chapters of
    verbatim master prose, each diagram board anchored to the page that
    discusses it;
  - exercise books (Goedemoed, Goedemoed3) -> one chapter per study theme, a
    gallery of solvable positions.

Every board carries the engine-parsed start position; when a *verified* forced
solution exists for that diagram (``strategy_exercises.json``) its line is
reconstructed move-by-move (path + captures) so the reader can step or solve it
exactly like a Débutant combination.

Run (from ``backend/`` with dilf on PYTHONPATH)::

    python -m strategy.build_manuel_interactif            # all sources
    python -m strategy.build_manuel_interactif SIJBRANDS  # one source

Output: ``frontend/src/manuels/data/<slug>.ts`` (one ES module per source) plus
``index.ts`` (the registry the page lists).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import game_engine as ge
from strategy import api

# --- output location -------------------------------------------------------
_FRONTEND_DATA = (
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "manuels" / "data"
)

# --- the six corpus sources, with a human title + level shown in the topbar.
# Prose sources read as a *course* (text + diagrams); the two Goedemoed volumes
# read as a themed *exercise book* (galleries of solvable positions).
SOURCES: dict[str, dict] = {
    "SIJBRANDS": {
        "slug": "sijbrands",
        "book": "Sijbrands — Cours de jeu de dames",
        "level": "Théorie",
        "kind": "prose",
    },
    "SPRINGER": {
        "slug": "springer",
        "book": "Springer — Cours de jeu de dames",
        "level": "Théorie",
        "kind": "prose",
    },
    "ROOZENBURG": {
        "slug": "roozenburg",
        "book": "Roozenburg — Le jeu de position",
        "level": "Théorie",
        "kind": "prose",
    },
    "KELLER": {
        "slug": "keller",
        "book": "Keller — Systèmes de jeu",
        "level": "Théorie",
        "kind": "prose",
    },
    "GOEDEMOED": {
        "slug": "goedemoed",
        "book": "Goedemoed — A Course in Draughts",
        "level": "Exercices",
        "kind": "theme",
    },
    "GOEDEMOED3": {
        "slug": "goedemoed3",
        "book": "Goedemoed — Exercices (vol. 3)",
        "level": "Exercices",
        "kind": "theme",
    },
}

_PIECE_BUCKET = {
    ge.WHITE_MAN: "wm",
    ge.WHITE_KING: "wk",
    ge.BLACK_MAN: "bm",
    ge.BLACK_KING: "bk",
}


def _fen_to_start(fen: str) -> dict | None:
    """Engine-parse a FEN into the viewer's ``start`` shape, or None if it can't
    be parsed (the position then yields no board)."""
    try:
        st = ge.fen_to_board(fen)
    except Exception:  # noqa: BLE001 — malformed FEN: drop the diagram
        return None
    out = {"wm": [], "wk": [], "bm": [], "bk": [], "turn": st.turn}
    for sq in range(1, 51):
        bucket = _PIECE_BUCKET.get(st.board[sq])
        if bucket:
            out[bucket].append(sq)
    return out


def _reconstruct_moves(initial_fen: str, pdn_moves: list[str]) -> list[dict]:
    """Replay a verified PDN solution line through the engine, emitting one
    ``{n, f, t, c, path, p}`` move per ply (path + captured squares + promotion
    flag) — exactly the shape ``BoardCard`` animates. Stops at the first ply
    that diverges from the reconstructed board (keeps the legal prefix)."""
    try:
        st = ge.fen_to_board(initial_fen)
    except Exception:  # noqa: BLE001
        return []
    out: list[dict] = []
    for pdn in pdn_moves:
        path = [int(x) for x in re.split(r"[-x]", pdn) if x]
        legal = ge.get_legal_moves(st)
        mv = next((m for m in legal if m.path == path), None)
        if mv is None:  # notation omitted intermediate squares: match endpoints
            mv = next(
                (m for m in legal if m.path[0] == path[0] and m.path[-1] == path[-1]),
                None,
            )
        if mv is None:
            break
        f, t = mv.path[0], mv.path[-1]
        was_king = st.board[f] in (ge.WHITE_KING, ge.BLACK_KING)
        st = ge.apply_move(st, mv)
        promoted = (not was_king) and st.board[t] in (ge.WHITE_KING, ge.BLACK_KING)
        out.append(
            {
                "n": pdn,
                "f": f,
                "t": t,
                "c": list(mv.captures),
                "path": list(mv.path),
                "p": bool(promoted),
            }
        )
    return out


_WS = re.compile(r"[ \t]*\n[ \t]*")
_MULTISPACE = re.compile(r"[ \t]{2,}")


def _clean_prose(text: str) -> list[str]:
    """Split an OCR'd passage into display paragraphs. Blank lines separate
    paragraphs; single newlines (pdftotext column wraps) become spaces. Text is
    kept verbatim otherwise (anti-hallucination: we never rewrite the masters)."""
    text = text.replace("\r", "")
    paras = re.split(r"\n[ \t]*\n", text)
    out: list[str] = []
    for para in paras:
        joined = _WS.sub(" ", para).strip()
        joined = _MULTISPACE.sub(" ", joined)
        if joined:
            out.append(joined)
    return out


def _position(source: str, page: int, number: int, fen: str,
              sections: dict, soln: dict, ch: int) -> dict | None:
    start = _fen_to_start(fen)
    if start is None:
        return None
    pid = f"{source}_p{page:04d}_d{number}"
    sec = sections.get(page) or {}
    theme = sec.get("theme") or sec.get("title")
    pos: dict = {
        "id": pid,
        "ch": ch,
        "title": f"Diagramme {number} — p. {page}",
        "start": start,
        "moves": [],
    }
    if theme:
        pos["theme"] = theme
    entry = soln.get((page, number))
    if entry and entry.get("moves"):
        moves = _reconstruct_moves(fen, entry["moves"])
        if moves:
            pos["moves"] = moves
            pos["pub"] = " ".join(entry["moves"])
            # Verified forced win: name the winning side for the verdict badge.
            pos["win"] = "white" if fen[:1].upper() == "W" else "black"
            if entry.get("prompt"):
                pos["prompt"] = entry["prompt"]
    return pid, pos  # type: ignore[return-value]


def _diags_by_page(manifest: dict) -> dict[int, list[int]]:
    by_page: dict[int, list[int]] = {}
    for (page, number) in sorted(manifest):
        by_page.setdefault(page, []).append(number)
    return by_page


def build_prose(source: str) -> dict:
    """Course-style book: verbatim prose chapters with each diagram board
    anchored to the page whose prose discusses it. Diagrams never reached by
    prose are gathered into a closing 'Autres diagrammes' chapter so none are
    lost."""
    raw = api._book_chapters(source)
    sections = api._load_diagram_sections(source)
    manifest = api._load_diagram_manifest(source)
    soln = api._solution_index(source)
    by_page = _diags_by_page(manifest)

    chapters: list[dict] = []
    blocks: list[dict] = []
    positions: dict[str, dict] = {}
    emitted: set[tuple[int, int]] = set()

    def emit_board(page: int, number: int, ch: int) -> None:
        fen = api._fen_for(source, page, number)
        if not fen:
            return
        made = _position(source, page, number, fen, sections, soln, ch)
        if made is None:
            return
        pid, pos = made
        positions[pid] = pos
        blocks.append({"type": "board", "id": pid, "ch": ch})
        emitted.add((page, number))

    for ci, ch in enumerate(raw, start=1):
        title = (ch.get("title") or ch.get("heading") or f"Chapitre {ci}").strip()
        chapters.append({"n": ci, "title": title})
        blocks.append({"type": "h2", "ch": ci, "runs": [{"t": title}]})
        heading = (ch.get("heading") or "").strip()
        if heading and heading.lower() != title.lower():
            blocks.append({"type": "h3", "ch": ci, "runs": [{"t": heading}]})
        seen_pages: set[int] = set()
        for p in ch["passages"]:
            for para in _clean_prose(p.text):
                blocks.append({"type": "p", "ch": ci, "runs": [{"t": para}]})
            if p.page not in seen_pages:
                seen_pages.add(p.page)
                for number in by_page.get(p.page, []):
                    if (p.page, number) not in emitted:
                        emit_board(p.page, number, ci)

    # Safety net: any valid diagram never anchored to prose -> closing gallery.
    leftover = [(pg, nb) for (pg, nb) in sorted(manifest) if (pg, nb) not in emitted]
    if leftover:
        ci = len(chapters) + 1
        chapters.append({"n": ci, "title": "Autres diagrammes"})
        blocks.append({"type": "h2", "ch": ci, "runs": [{"t": "Autres diagrammes"}]})
        for (pg, nb) in leftover:
            emit_board(pg, nb, ci)

    return {
        "book": SOURCES[source]["book"],
        "level": SOURCES[source]["level"],
        "chapters": chapters,
        "blocks": blocks,
        "positions": positions,
    }


def build_theme(source: str) -> dict:
    """Exercise book: one chapter per printed study theme, a gallery of
    solvable positions (verified solution lines where mined)."""
    tc = api._theme_chapters(source) or []
    sections = api._load_diagram_sections(source)
    soln = api._solution_index(source)

    chapters: list[dict] = []
    blocks: list[dict] = []
    positions: dict[str, dict] = {}

    for ci, ch in enumerate(tc, start=1):
        theme = ch["theme"]
        diagrams = ch["diagrams"]
        chapters.append({"n": ci, "title": theme})
        blocks.append({"type": "h2", "ch": ci, "runs": [{"t": theme}]})
        n_solv = sum(1 for d in diagrams if d in soln)
        intro = f"{len(diagrams)} positions d'étude sur ce thème"
        intro += f", dont {n_solv} avec solution vérifiée." if n_solv else "."
        blocks.append({"type": "p", "ch": ci, "runs": [{"t": intro}]})
        for (page, number) in diagrams:
            fen = api._fen_for(source, page, number)
            if not fen:
                continue
            made = _position(source, page, number, fen, sections, soln, ci)
            if made is None:
                continue
            pid, pos = made
            positions[pid] = pos
            blocks.append({"type": "board", "id": pid, "ch": ci})

    return {
        "book": SOURCES[source]["book"],
        "level": SOURCES[source]["level"],
        "chapters": chapters,
        "blocks": blocks,
        "positions": positions,
    }


def build_source(source: str) -> dict:
    kind = SOURCES[source]["kind"]
    return build_prose(source) if kind == "prose" else build_theme(source)


_HEADER = (
    "// Auto-generated by backend/strategy/build_manuel_interactif.py "
    "— do not edit by hand.\n"
    "// Re-run after updating prose fixtures, diagram FENs or "
    "strategy_exercises.json.\n"
    "import type { ManuelData } from '../ManuelInteractif'\n\n"
)


def write_source(source: str) -> dict:
    data = build_source(source)
    slug = SOURCES[source]["slug"]
    _FRONTEND_DATA.mkdir(parents=True, exist_ok=True)
    body = json.dumps(data, ensure_ascii=False, indent=0)
    out = _FRONTEND_DATA / f"{slug}.ts"
    out.write_text(
        _HEADER + f"const DATA: ManuelData = {body}\n\nexport default DATA\n",
        encoding="utf-8",
    )
    n_pos = len(data["positions"])
    n_solv = sum(1 for p in data["positions"].values() if p.get("moves"))
    print(
        f"  {source:11s} -> {slug}.ts  "
        f"{len(data['chapters']):3d} ch  {len(data['blocks']):5d} blocks  "
        f"{n_pos:4d} positions ({n_solv} solvables)  {out.stat().st_size // 1024} KiB"
    )
    return {"source": source, **SOURCES[source], "stats": {
        "chapters": len(data["chapters"]), "positions": n_pos, "solvable": n_solv}}


def write_index(metas: list[dict]) -> None:
    """Registry the page maps over: each manual lazy-loads its data module."""
    lines = [
        "// Auto-generated by backend/strategy/build_manuel_interactif.py "
        "— do not edit by hand.",
        "import type { ManuelData } from './ManuelInteractif'",
        "",
        "export interface ManuelEntry {",
        "  id: string",
        "  book: string",
        "  level: string",
        "  load: () => Promise<{ default: ManuelData }>",
        "}",
        "",
        "export const MANUELS: ManuelEntry[] = [",
    ]
    for m in metas:
        slug = m["slug"]
        lines.append(
            f"  {{ id: {json.dumps(slug)}, book: {json.dumps(m['book'])}, "
            f"level: {json.dumps(m['level'])}, "
            f"load: () => import('./data/{slug}') }},"
        )
    lines.append("]")
    lines.append("")
    idx = _FRONTEND_DATA.parent / "index.ts"
    idx.write_text("\n".join(lines), encoding="utf-8")
    print(f"  index.ts -> {len(metas)} manuals")


def main(argv: list[str]) -> int:
    wanted = [a.upper() for a in argv[1:]] or list(SOURCES)
    unknown = [s for s in wanted if s not in SOURCES]
    if unknown:
        print(f"unknown source(s): {unknown}; known: {list(SOURCES)}")
        return 2
    print("Building interactive manuals:")
    metas = [write_source(s) for s in wanted]
    if set(wanted) == set(SOURCES):
        write_index(metas)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
