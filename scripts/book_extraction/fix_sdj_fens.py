"""Correct the Sens du jeu diagram FENs in ``sens_du_jeu_lessons.json``.

The original extraction ran at a resolution where the *white* men (light discs)
were often missed, so many illustrative diagrams came out with only their black
men (e.g. « L'enchaînement latéral » → ``W:W:B16,17,21``, its two white men
dropped). Re-reading each board at dpi 300 resolves the light discs.

Alignment is verified per diagram: a re-read FEN replaces the stored one only
when its **black** men set is identical (the black men were read correctly the
first time), so we only ever *add the missing white men* to the right board —
never reassign a position. Labels are left untouched.

Run (repo root)::

    PYTHONPATH=backend python scripts/book_extraction/fix_sdj_fens.py
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
sys.path.insert(0, str(_HERE))
from fen_extraction import analyze_board_fen  # noqa: E402

PDF = _ROOT / "docs/livres/apprentissage/dubois_apprendre_sens_du_jeu.pdf"
LESSONS = _ROOT / "backend/sens_du_jeu_lessons.json"
_TOC_RE = re.compile(r"Chapitre\s+\d+\s*:\s*.+?\.{2,}\s*(\d+)\s*$")


def _blacks(fen: str) -> set[int]:
    m = re.search(r":B([K\d,]*)$", fen or "")
    return {int(x.lstrip("K")) for x in m.group(1).split(",") if x} if m else set()


def _board_rects(page):
    out = []
    for im in page.get_images(full=True):
        for r in page.get_image_rects(im[0]):
            if 120 < r.width < 210 and 120 < r.height < 210 and abs(r.width - r.height) < 25:
                out.append(r)
    return sorted(out, key=lambda b: (round(b.y0), b.x0))


def main() -> int:
    doc = fitz.open(str(PDF))
    starts: list[int] = []
    for i in range(min(4, doc.page_count)):
        for ln in doc[i].get_text().split("\n"):
            m = _TOC_RE.search(ln.strip())
            if m:
                starts.append(int(m.group(1)))
    # Re-read every board on every page (dpi 300), grouped by chapter page range.
    sc = 300 / 72.0
    page_fens: dict[int, list[str]] = {}
    for pno in range(1, doc.page_count + 1):
        page = doc[pno - 1]
        rects = _board_rects(page)
        if not rects:
            continue
        pix = page.get_pixmap(dpi=300)
        g = cv2.cvtColor(np.frombuffer(pix.samples, dtype=np.uint8)
                         .reshape(pix.height, pix.width, pix.n)[:, :, :3], cv2.COLOR_RGB2GRAY)
        page_fens[pno] = [
            analyze_board_fen(g, int(r.x0 * sc), int(r.y0 * sc), int(r.x1 * sc), int(r.y1 * sc),
                              "W", 7, 11, 218.0, 95.0)
            for r in rects
        ]

    lessons = json.loads(LESSONS.read_text())
    updated = checked = 0
    for cid in sorted(lessons, key=int):
        order = int(cid) - 100  # chapters 101.. -> 1..
        if order < 1 or order > len(starts):
            continue
        p0 = starts[order - 1]
        p1 = starts[order] if order < len(starts) else doc.page_count + 1
        fens = [f for pno in range(p0, p1) for f in page_fens.get(pno, [])]
        diags = lessons[cid].get("diagrams") or []
        for i, d in enumerate(diags):
            if i >= len(fens):
                break
            checked += 1
            new = fens[i]
            if _blacks(new) == _blacks(d.get("fen", "")) and new != d.get("fen"):
                d["fen"] = new
                updated += 1
    LESSONS.write_text(json.dumps(lessons, ensure_ascii=False, indent=2) + "\n")
    print(f"checked {checked} diagrams, corrected {updated} FENs (added missing white men)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
