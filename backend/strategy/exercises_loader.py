"""Expose the mined manual combinations as seedable exercise rows.

Reads ``strategy_exercises.json`` (produced by ``generate_exercises.py``)
and yields rows in the exact shape ``db/schema.py`` upserts, mirroring
``manuels.loader``. IDs live in their own range so they never collide
with the manuel_debutant rows (2001+).
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_PATH = Path(__file__).resolve().parent / "strategy_exercises.json"

# IDs 5001+ — clear of manuel_debutant (2001+) and the legacy Dubois
# range (1..572) dropped at init.
STRATEGY_ID_OFFSET = 5000


@lru_cache(maxsize=1)
def _raw() -> list[dict[str, Any]]:
    if not _PATH.is_file():
        return []
    return json.loads(_PATH.read_text()).get("exercises", [])


# Strategy-exercise IDs are assigned by the enumerate order in db/schema.py and
# are referenced by curriculum_resolved.json and by users' saved progress, so a
# source's IDs must never shift once it has been seeded. We therefore freeze the
# *order in which sources were introduced*: each new manual is appended strictly
# after every earlier one, so it only ever occupies fresh IDs. Within a source,
# entries stay diagram-id-sorted. Append new sources to the END of this tuple.
_SOURCE_ORDER = (
    "KELLER", "SIJBRANDS", "SPRINGER", "GOEDEMOED", "GOEDEMOED3",
    # PDF-extracted books (2026-07): appended in one batch, fixed order.
    "PERF_COMBINAISONS", "FINS_DE_PARTIE", "ENCHAINEMENTS", "REFERENTIEL",
    "PERF_SDJ_T1", "PERF_SDJ_T2", "PERF_SDJ_T3", "COUTTET",
)


def _sort_key(ex: dict[str, Any]) -> tuple:
    src = ex["source"].upper()
    # Unknown (future) sources sort after all known ones, still deterministically.
    rank = _SOURCE_ORDER.index(src) if src in _SOURCE_ORDER else len(_SOURCE_ORDER)
    return (rank, ex["diagram_id"])


def all_strategy_exercises() -> list[dict[str, Any]]:
    """Exercise rows ready for ``INSERT INTO exercises (...)``.

    Legacy sources are emitted first in their original diagram-id order so their
    seeded IDs stay fixed; newer sources are appended afterwards.
    """
    rows: list[dict[str, Any]] = []
    for ex in sorted(_raw(), key=_sort_key):
        rows.append(
            {
                "name": ex["name"],
                "description": ex["description"],
                "initial_fen": ex["initial_fen"],
                "solution_moves": ex["solution_moves"],
                "difficulty": ex["difficulty"],
                "category": ex["category"],
                "hint": ex["hint"],
                "book_id": f"manuel_{ex['source'].lower()}",
            }
        )
    return rows
