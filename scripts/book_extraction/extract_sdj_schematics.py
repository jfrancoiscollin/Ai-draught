"""Extract the *territorial schematic* diagrams from Dubois « Apprendre le sens
du jeu » — the annotated empty boards (Camp des Noirs, Zone frontière, ailes,
flancs, formations…) that carry no piece position, so the FEN pipeline dropped
them and left their labels orphaned in the prose.

The board diagrams are embedded raster images with exact placement rects, so we
locate every board reliably (no fragile pixel detection). A board is a
*schematic* when it holds fewer than 6 pieces (an empty/annotated board); we
then render a page-region crop around it — the checkerboard **plus** the
surrounding labels and partition lines — as a PNG data URI. Positions
(piece-bearing boards) are left to the normal FEN reader.

Output: ``backend/sens_du_jeu_schematics.json`` — ``{reader_chapter_n: [dataURI…]}``
in reading order, consumed by build_parcours_manuels to insert image blocks.

Run (repo root)::

    PYTHONPATH=backend python scripts/book_extraction/extract_sdj_schematics.py
"""
from __future__ import annotations

import base64
import json
import re
import sys
from pathlib import Path

import fitz  # type: ignore
import numpy as np  # type: ignore
import cv2  # type: ignore

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent.parent

PDF = _ROOT / "docs/livres/apprentissage/dubois_apprendre_sens_du_jeu.pdf"
OUT = _ROOT / "backend/sens_du_jeu_schematics.json"

_TOC_RE = re.compile(r"Chapitre\s+\d+\s*:\s*.+?\.{2,}\s*(\d+)\s*$")
_DPI = 150
# A territorial schematic is an *empty* board (its embedded raster carries no
# baked-in pieces — dark-pixel fraction at the bare-checkerboard baseline
# ~0.037) that annotates the board with **territorial** regions. Requiring both
# the empty raster AND a territorial keyword on the page keeps us to the true
# schematics (Camp/Zone/Flanc/Aile/Territoire) and excludes piece diagrams whose
# men happen to be drawn as separate overlays.
_EMPTY_DARK_MAX = 0.05
# Strong labels that appear only as schematic annotations (not in running
# prose): the horizontal partition (Camp des Noirs/Blancs) and the frontier
# band (Zone frontière) — present on every territorial schematic, absent from
# the pion/formation chapters' text.
_TERRITORIAL_RE = re.compile(r"Camp des (?:Noirs|Blancs)|Zone frontière", re.IGNORECASE)


def _chapter_pages(doc) -> list[int]:
    """Start page of each of the 35 chapters, in reader order, parsed from the
    table of contents (dotted-leader lines 'Chapitre N : title …… PAGE')."""
    starts: list[int] = []
    for i in range(min(4, doc.page_count)):
        for ln in doc[i].get_text().split("\n"):
            m = _TOC_RE.search(ln.strip())
            if m:
                starts.append(int(m.group(1)))
    return starts


def _empty_board(doc, xref: int) -> bool:
    """True when the embedded board raster is an empty (annotated) board — its
    baked-in dark-pixel fraction is at the bare-checkerboard baseline, i.e. it
    carries no pieces."""
    try:
        data = doc.extract_image(xref)["image"]
        img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    except Exception:  # noqa: BLE001
        return False
    return img is not None and float((img < 80).mean()) < _EMPTY_DARK_MAX


def _crop_data_uri(page, clip: fitz.Rect) -> str:
    pix = page.get_pixmap(dpi=_DPI, clip=clip)
    png = pix.tobytes("png")
    return "data:image/png;base64," + base64.b64encode(png).decode()


def main() -> int:
    doc = fitz.open(str(PDF))
    starts = _chapter_pages(doc)
    if len(starts) < 10:
        print(f"! only {len(starts)} chapters parsed from TOC")
    # reader chapter n (1..) spans [starts[n-1], starts[n])
    def chapter_of(page: int) -> int | None:
        n = None
        for idx, sp in enumerate(starts, start=1):
            if sp <= page:
                n = idx
            else:
                break
        return n

    out: dict[str, list[str]] = {}
    n_sch = 0
    for pno in range(1, doc.page_count + 1):
        page = doc[pno - 1]
        ch = chapter_of(pno)
        if ch is None:
            continue
        if not _TERRITORIAL_RE.search(page.get_text()):
            continue  # no territorial vocabulary on this page → no schematic here
        # Board images: near-square, board-sized placement (~150-190pt).
        boards = []  # (rect, is_empty)
        for im in page.get_images(full=True):
            for r in page.get_image_rects(im[0]):
                if 120 < r.width < 210 and 120 < r.height < 210 and abs(r.width - r.height) < 25:
                    boards.append((r, _empty_board(doc, im[0])))
        pw = page.rect.width
        for r, empty in sorted(boards, key=lambda b: (round(b[0].y0), b[0].x0)):
            if not empty:
                continue  # a real position — the FEN reader shows it
            # Schematic: crop board + margins for its labels (left / below /
            # rotated inside), clipped to the page and its column.
            left_lim = 30 if r.x0 < pw / 2 else pw / 2
            clip = fitz.Rect(max(left_lim, r.x0 - 145), max(20, r.y0 - 22),
                             min(pw - 20, r.x1 + 22), r.y1 + 40)
            out.setdefault(str(ch), []).append(_crop_data_uri(page, clip))
            n_sch += 1
    OUT.write_text(json.dumps(out, ensure_ascii=False))
    kb = OUT.stat().st_size // 1024
    print(f"chapters with schematics: {len(out)} | schematics: {n_sch} | {kb} KiB -> {OUT.name}")
    for k in sorted(out, key=int):
        print(f"  ch {k}: {len(out[k])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
