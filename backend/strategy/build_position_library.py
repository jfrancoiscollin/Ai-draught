"""Consolidate every extracted diagram position into a single, engine-validated
*strategic position library*.

This is the foundation the rest of the strategic features build on
(knowledge-base examples, study exercises, prose ↔ diagram linkage). It
merges, per source:

- ``diagrams_manifest.json``      — the list of detected diagrams (page, number)
- ``diagrams_fens.json``          — human-verified FENs (source of truth)
- ``diagrams_fens_auto.json``     — rules-based detector output (``_auto``)
- ``diagram_sections.json``       — per-page chapter metadata (Leçon N + title)

For every diagram it picks the best available FEN (human wins over auto),
runs it through ``game_engine`` to record legality facts (piece counts,
side to move, number of legal moves, whether a capture is available) and
flags positions that fail basic sanity (empty board, >20 men a side, no
legal move) as ``valid: false`` so downstream consumers can opt out.

Run from ``backend/`` (so ``game_engine`` imports cleanly)::

    python -m strategy.build_position_library            # all sources
    python -m strategy.build_position_library SIJBRANDS  # one source

Output: ``backend/strategy/position_library.json``. Re-runnable and
deterministic — safe to commit and to wire into CI as a freshness check.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any, Optional

# ``game_engine`` lives at backend/ root; this module is imported as
# ``strategy.build_position_library`` from there.
import game_engine as ge

_PAGES_DIR = Path(__file__).parent / "pages"
_OUT_PATH = Path(__file__).parent / "position_library.json"

# Order matters only for stable output. Manuals scanned to date.
SOURCES = ("SIJBRANDS", "SPRINGER", "ROOZENBURG", "KELLER", "GOEDEMOED", "GOEDEMOED3")

# A man or king of either colour, for piece counting.
_WHITE = {ge.WHITE_MAN, ge.WHITE_KING}
_BLACK = {ge.BLACK_MAN, ge.BLACK_KING}


def _load(src_dir: Path, name: str) -> Any:
    p = src_dir / name
    if not p.is_file():
        return None
    return json.loads(p.read_text())


def _fens_by_key(payload: Any) -> dict[tuple[int, int], str]:
    """``{"entries": [{page, number, fen}]}`` → ``{(page, number): fen}``."""
    if not payload:
        return {}
    out: dict[tuple[int, int], str] = {}
    for e in payload.get("entries", []):
        out[(e["page"], e["number"])] = e["fen"]
    return out


def _sections_by_page(payload: Any) -> dict[int, dict[str, str]]:
    """``diagram_sections.json`` is keyed by page (as a string)."""
    if not payload:
        return {}
    return {int(k): v for k, v in payload.items()}


# A *real* lesson marker, e.g. "Leçon 24", "Thème 6", "Chapitre 3".
# ``extract_strategy_sections.py`` is heuristic: the numbered heading is
# reliable, but the accompanying ``title`` drifts between a genuine
# lesson title ("Le débordement") and a stray caption ("DIAGRAMME 1",
# "Exercice 2") or a wrapped sentence. We therefore (1) require a
# numbered lesson heading and (2) resolve, per heading, the best clean
# title seen across the source's pages — unmatched pages keep their
# position in the library but carry no theme.
_THEME_HEADING_RE = re.compile(
    r"^\s*(le[cç]on|th[eè]me|theme|chapitre|partie)\s*\d",
    re.IGNORECASE,
)
# Titles that are captions / TOC lines / wrapped prose, not lesson names.
_JUNK_TITLE_RE = re.compile(r"^\s*(diagramme|exercice)\b", re.IGNORECASE)


def _clean_heading(sec: dict[str, str]) -> Optional[str]:
    heading = (sec.get("heading") or "").strip()
    return heading if _THEME_HEADING_RE.match(heading) else None


def _is_clean_title(title: str) -> bool:
    title = (title or "").strip()
    if not title or len(title) > 60:
        return False
    if _JUNK_TITLE_RE.match(title):
        return False
    if "...." in title:  # table-of-contents dot leader
        return False
    if re.fullmatch(r"\d+(\.\d+)*\.?", title):  # bare section number "1.1"
        return False
    return True


def _resolve_theme_titles(
    sections: dict[int, dict[str, str]]
) -> dict[str, str]:
    """Map each clean heading to its best human-readable lesson title.

    Picks the most frequent non-junk title seen for the heading, falling
    back to the heading itself when no clean title exists.
    """
    from collections import Counter

    candidates: dict[str, Counter] = {}
    for sec in sections.values():
        heading = _clean_heading(sec)
        if not heading:
            continue
        candidates.setdefault(heading, Counter())
        title = (sec.get("title") or "").strip()
        if _is_clean_title(title):
            candidates[heading][title] += 1
    resolved: dict[str, str] = {}
    for heading, counter in candidates.items():
        resolved[heading] = counter.most_common(1)[0][0] if counter else heading
    return resolved


def _has_capture(moves: list[ge.Move]) -> bool:
    # A capture move lands via one or more 'x' separators in PDN.
    return any("x" in ge.move_to_pdn(m) for m in moves)


def _analyse_fen(fen: str) -> dict[str, Any]:
    """Engine-backed legality facts for a FEN.

    Never raises: ``fen_to_board`` returns an empty board on garbage,
    which we then flag as ``valid: false``.
    """
    st = ge.fen_to_board(fen)
    n_white = sum(1 for p in st.board if p in _WHITE)
    n_black = sum(1 for p in st.board if p in _BLACK)
    n_wk = sum(1 for p in st.board if p == ge.WHITE_KING)
    n_bk = sum(1 for p in st.board if p == ge.BLACK_KING)
    moves = ge.get_legal_moves(st)
    # A man on its own promotion row is impossible — it would already be a
    # king. White men promote on 1-5, black men on 46-50; any such man is a
    # sure detector misread, so the position is flagged invalid.
    illegal_men = sum(
        1 for sq in range(1, 6) if st.board[sq] == ge.WHITE_MAN
    ) + sum(
        1 for sq in range(46, 51) if st.board[sq] == ge.BLACK_MAN
    )
    valid = (
        n_white >= 1
        and n_black >= 1
        and n_white <= 20
        and n_black <= 20
        and len(moves) >= 1
        and illegal_men == 0
    )
    return {
        "side_to_move": st.turn,
        "n_white": n_white,
        "n_black": n_black,
        "n_white_kings": n_wk,
        "n_black_kings": n_bk,
        "n_legal_moves": len(moves),
        "has_capture": _has_capture(moves),
        "illegal_men": illegal_men,
        "valid": valid,
    }


def build_source(source: str) -> list[dict[str, Any]]:
    """Return the consolidated library entries for one source."""
    src_dir = _PAGES_DIR / source.lower()
    manifest = _load(src_dir, "diagrams_manifest.json")
    if not manifest:
        print(f"[skip] {source}: no diagrams_manifest.json")
        return []

    human = _fens_by_key(_load(src_dir, "diagrams_fens.json"))
    auto = _fens_by_key(_load(src_dir, "diagrams_fens_auto.json"))
    sections = _sections_by_page(_load(src_dir, "diagram_sections.json"))
    theme_titles = _resolve_theme_titles(sections)

    entries: list[dict[str, Any]] = []
    for m in manifest["entries"]:
        page, number = m["page"], m["number"]
        key = (page, number)
        if key in human:
            fen, kind = human[key], "human"
        elif key in auto:
            fen, kind = auto[key], "auto"
        else:
            # Diagram detected (crop exists) but no FEN at all.
            fen, kind = None, "none"

        heading = _clean_heading(sections.get(page, {}))
        theme = theme_titles.get(heading) if heading else None
        # Some sources (e.g. Goedemoed) declare a direct French section theme
        # per page instead of a numbered "Leçon N" heading. Honour it when the
        # generic lesson-heading resolver found nothing.
        if theme is None:
            direct = (sections.get(page, {}).get("theme") or "").strip()
            if direct:
                theme = direct
                heading = heading or direct
        entry: dict[str, Any] = {
            "id": f"{source}_p{page:04d}_d{number}",
            "source": source,
            "page": page,
            "number": number,
            "fen": fen,
            "kind": kind,
            "section_heading": heading,
            "theme": theme,
        }
        if fen:
            entry.update(_analyse_fen(fen))
        else:
            entry["valid"] = False
        entries.append(entry)

    entries.sort(key=lambda e: (e["page"], e["number"]))
    return entries


def build(sources: tuple[str, ...] = SOURCES) -> dict[str, Any]:
    all_entries: list[dict[str, Any]] = []
    per_source: dict[str, dict[str, int]] = {}
    for src in sources:
        ents = build_source(src)
        all_entries.extend(ents)
        per_source[src] = {
            "total": len(ents),
            "valid": sum(1 for e in ents if e.get("valid")),
            "human": sum(1 for e in ents if e["kind"] == "human"),
            "auto": sum(1 for e in ents if e["kind"] == "auto"),
            "no_fen": sum(1 for e in ents if e["kind"] == "none"),
            "with_theme": sum(1 for e in ents if e.get("theme")),
        }

    # PDF-extracted books (their reader data files are the source of truth);
    # rows carry kind="pdf" and the same engine facts as the scanned entries.
    from . import pdf_books  # noqa: PLC0415 — keeps partial scanned rebuilds cheap

    pdf_sources: list[str] = []
    if set(sources) == set(SOURCES):  # partial rebuilds keep to scanned sources
        by_src: dict[str, list[dict[str, Any]]] = {}
        for row in pdf_books.entries(_analyse_fen):
            by_src.setdefault(row["source"], []).append(row)
        for src in sorted(by_src):
            ents = sorted(by_src[src], key=lambda e: (e["page"], e["number"]))
            all_entries.extend(ents)
            pdf_sources.append(src)
            per_source[src] = {
                "total": len(ents),
                "valid": sum(1 for e in ents if e.get("valid")),
                "human": 0,
                "auto": 0,
                "no_fen": 0,
                "with_theme": sum(1 for e in ents if e.get("theme")),
            }

    return {
        "$comment": (
            "Generated by strategy/build_position_library.py — do not edit by "
            "hand. Consolidated, engine-validated diagram positions from the "
            "scanned manuals and the PDF-extracted books (strategy/pdf_books). "
            "Re-run after updating any diagrams_fens*.json or reader data file."
        ),
        "generated_on": date.today().isoformat(),
        "sources": list(sources) + pdf_sources,
        "stats": {
            "total": len(all_entries),
            "valid": sum(1 for e in all_entries if e.get("valid")),
            "per_source": per_source,
        },
        "positions": all_entries,
    }


def main(argv: list[str]) -> int:
    sources = tuple(s.upper() for s in argv[1:]) or SOURCES
    payload = build(sources)
    _OUT_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    )
    st = payload["stats"]
    print(f"[ok] {st['valid']}/{st['total']} valid positions → {_OUT_PATH}")
    for src, s in st["per_source"].items():
        print(
            f"     {src:11s} total={s['total']:4d} valid={s['valid']:4d} "
            f"human={s['human']:4d} auto={s['auto']:4d} "
            f"no_fen={s['no_fen']:3d} themed={s['with_theme']:4d}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
