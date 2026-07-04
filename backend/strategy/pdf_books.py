"""Positions of the PDF-extracted books, in position-library schema.

The seven books extracted straight from their PDFs (Perfectionnement
combinaisons, Fins de partie, Référentiel des systèmes, Perfectionnement sens
du jeu t.1-3, Les enchaînements, Couttet ouvertures) emit their positions into
the frontend reader data modules (``frontend/src/manuels/data/*.ts``) — already
engine-validated at extraction time. This module re-exposes those positions as
library rows so ``build_position_library`` can consolidate them next to the
scanned manuals, making them available to the *analysis* side: knowledge-base
themes, tip example matching, and the strategic position lookups.

The reader files are the single source of truth (regenerating a book updates
both the reader and, on the next library rebuild, the analysis material).
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable, Iterator

_DATA_DIR = (
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "manuels" / "data"
)

# (source code, reader slug) — source codes join SIJBRANDS & co in the library.
BOOKS: tuple[tuple[str, str], ...] = (
    ("PERF_COMBINAISONS", "perfectionnement_combinaisons"),
    ("FINS_DE_PARTIE", "fins_de_partie"),
    ("REFERENTIEL", "referentiel_systemes"),
    ("PERF_SDJ_T1", "perf_sens_du_jeu_t1"),
    ("PERF_SDJ_T2", "perf_sens_du_jeu_t2"),
    ("PERF_SDJ_T3", "perf_sens_du_jeu_t3"),
    ("ENCHAINEMENTS", "enchainements"),
    ("COUTTET", "couttet_ouvertures"),
)

_PAYLOAD_RE = re.compile(r"const DATA: ManuelData = (.*)\n\nexport default", re.S)
_PAGE_RE = re.compile(r"_(?:p|s|d)(\d+)")
_CHAPTER_PREFIX_RE = re.compile(r"^Chapitre\s+\d+\s*[:—–-]\s*", re.IGNORECASE)


def _reader_data(slug: str) -> dict | None:
    path = _DATA_DIR / f"{slug}.ts"
    if not path.is_file():
        return None
    m = _PAYLOAD_RE.search(path.read_text(encoding="utf-8"))
    return json.loads(m.group(1)) if m else None


def _fen_of(start: dict) -> str:
    def grp(men: list, kings: list) -> str:
        return ",".join([str(s) for s in sorted(men)]
                        + [f"K{s}" for s in sorted(kings)])
    turn = "W" if start.get("turn") == "white" else "B"
    return f"{turn}:W{grp(start['wm'], start['wk'])}:B{grp(start['bm'], start['bk'])}"


def entries(analyse: Callable[[str], dict[str, Any]]) -> Iterator[dict[str, Any]]:
    """Yield library rows for every PDF-book position.

    ``analyse`` is the engine fact extractor (``_analyse_fen`` of the library
    builder) so the rows carry exactly the same legality facts as scanned ones.
    """
    for source, slug in BOOKS:
        data = _reader_data(slug)
        if not data:
            continue
        titles = {c["n"]: c["title"] for c in data.get("chapters", [])}
        counter: dict[int, int] = {}
        for pid, pos in data.get("positions", {}).items():
            # Steppable game-line boards (``<SLUG>_line<k>``) are a reader-only
            # convenience — their start is a mid-game position reached by a
            # replayed line, not an extracted diagram. Keep the analysis
            # material to the actual diagrams.
            if "_line" in pid:
                continue
            m = _PAGE_RE.search(pid)
            page = int(m.group(1)) if m else int(pos.get("ch") or 0)
            counter[page] = counter.get(page, 0) + 1
            theme = _CHAPTER_PREFIX_RE.sub("", titles.get(pos.get("ch"), "") or "").strip()
            fen = _fen_of(pos["start"])
            row: dict[str, Any] = {
                "id": f"{source}_p{page:04d}_d{counter[page]}",
                "source": source,
                "page": page,
                "number": counter[page],
                "fen": fen,
                "kind": "pdf",
                "section_heading": theme or None,
                "theme": theme or None,
            }
            row.update(analyse(fen))
            yield row
