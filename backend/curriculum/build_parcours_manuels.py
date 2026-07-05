"""Assemble each *learning-path module* into the interactive-manual DATA used by
the frontend ``ManuelInteractif`` reader (one reader per module, its lessons as
chapters).

The curated curriculum (``curriculum_resolved.json``) is levels → modules →
lessons → items. This generator turns every module into a self-contained
``{book, level, chapters, blocks, positions}`` object, reusing the existing
content — nothing is invented:

  - lesson prose: the full master text (``lessons.json`` for the Débutant track,
    ``sens_du_jeu_lessons.json`` for the Sens-du-jeu track) or the curriculum's
    own ``intro`` when there is no long form;
  - exercise items: matched by name to the seeded exercises
    (``db/exercises_data.py``, ``db/sens_du_jeu_exercises.py``,
    ``strategy/strategy_exercises.json``) → a playable board whose verified
    solution line is reconstructed move-by-move through the engine;
  - position items: their inline FEN (+ a verified line when one exists);
  - manual items: a pointer paragraph to the full theoretical manual reader.

Run (from ``backend/``)::

    python -m curriculum.build_parcours_manuels            # all modules
    python -m curriculum.build_parcours_manuels int_comb_2 # one module

Output: ``frontend/src/manuels/data/parcours_<module_id>.ts`` + ``parcours.ts``
(the registry the learning path opens by module id).
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any, Optional

import game_engine as ge

_BACKEND = Path(__file__).resolve().parents[1]
_FRONTEND_DATA = _BACKEND.parent / "frontend" / "src" / "manuels" / "data"

_PIECE_BUCKET = {
    ge.WHITE_MAN: "wm", ge.WHITE_KING: "wk", ge.BLACK_MAN: "bm", ge.BLACK_KING: "bk",
}


# --- shared content sources -------------------------------------------------
def _load_py_list(module_file: str, var: str) -> list[dict]:
    path = _BACKEND / "db" / module_file
    spec = importlib.util.spec_from_file_location(module_file[:-3], path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return list(getattr(mod, var, []))


def _exercise_index() -> dict[str, dict]:
    """name -> {initial_fen, solution_moves, hint, …} across every seed source."""
    idx: dict[str, dict] = {}
    for rows in (
        _load_py_list("exercises_data.py", "INITIAL_EXERCISES"),
        _load_py_list("sens_du_jeu_exercises.py", "SENS_DU_JEU_EXERCISES"),
    ):
        for r in rows:
            if r.get("name") and r.get("initial_fen"):
                idx[r["name"]] = r
    strat = json.loads((_BACKEND / "strategy" / "strategy_exercises.json").read_text())
    for r in strat["exercises"]:
        if r.get("name") and r.get("initial_fen"):
            idx[r["name"]] = r
    return idx


def _diagram_solution_index() -> dict[str, dict]:
    """diagram_id -> verified exercise row (for inline 'position' items)."""
    strat = json.loads((_BACKEND / "strategy" / "strategy_exercises.json").read_text())
    return {r["diagram_id"]: r for r in strat["exercises"] if r.get("diagram_id")}


_CHAP_RE = re.compile(r"\s*Chapitre\s+(\d+)")


def _combinaisons_by_chapter() -> dict[int, list[dict]]:
    """The Dubois 'Apprendre les combinaisons' exercises grouped by their book
    chapter (parsed from ``description`` = "Chapitre N – …"). The Débutant
    reading lessons carry only prose (no items); their chapter N's worked
    combinations live here, so they become playable boards under each lesson."""
    by_ch: dict[int, list[dict]] = {}
    for ex in _load_py_list("exercises_data.py", "INITIAL_EXERCISES"):
        m = _CHAP_RE.match(ex.get("description", ""))
        if m and ex.get("initial_fen"):
            by_ch.setdefault(int(m.group(1)), []).append(ex)
    return by_ch


# --- engine helpers ---------------------------------------------------------
def _fen_to_start(fen: str) -> Optional[dict]:
    try:
        st = ge.fen_to_board(fen)
    except Exception:  # noqa: BLE001
        return None
    out: dict[str, Any] = {"wm": [], "wk": [], "bm": [], "bk": [], "turn": st.turn}
    for sq in range(1, 51):
        bucket = _PIECE_BUCKET.get(st.board[sq])
        if bucket:
            out[bucket].append(sq)
    return out


def _reconstruct_moves(fen: str, pdn_moves: list[str]) -> list[dict]:
    try:
        st = ge.fen_to_board(fen)
    except Exception:  # noqa: BLE001
        return []
    out: list[dict] = []
    for pdn in pdn_moves:
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


_WS = re.compile(r"[ \t]*\n[ \t]*")
_MULTISPACE = re.compile(r"[ \t]{2,}")


def _paras(text: str) -> list[str]:
    text = (text or "").replace("\r", "")
    out = []
    for para in re.split(r"\n[ \t]*\n", text):
        joined = _MULTISPACE.sub(" ", _WS.sub(" ", para).strip())
        if joined:
            out.append(joined)
    return out


# --- per-position builders --------------------------------------------------
def _board_from_exercise(pid: str, ch: int, ex: dict, title: str, theme: str) -> Optional[dict]:
    start = _fen_to_start(ex["initial_fen"])
    if start is None:
        return None
    pos: dict[str, Any] = {"id": pid, "ch": ch, "title": title, "start": start, "moves": []}
    if theme:
        pos["theme"] = theme
    sol = ex.get("solution_moves") or []
    if sol:
        moves = _reconstruct_moves(ex["initial_fen"], sol)
        if moves:
            pos["moves"] = moves
            pos["pub"] = " ".join(sol)
            pos["win"] = "white" if ex["initial_fen"][:1].upper() == "W" else "black"
    if ex.get("hint"):
        pos["exp"] = ex["hint"]
    return pos


def _board_from_position(pid: str, ch: int, fen: str, theme: str,
                         sol_row: Optional[dict]) -> Optional[dict]:
    start = _fen_to_start(fen)
    if start is None:
        return None
    pos: dict[str, Any] = {"id": pid, "ch": ch, "title": theme or pid,
                           "start": start, "moves": []}
    if theme:
        pos["theme"] = theme
    if sol_row and sol_row.get("solution_moves"):
        moves = _reconstruct_moves(fen, sol_row["solution_moves"])
        if moves:
            pos["moves"] = moves
            pos["pub"] = " ".join(sol_row["solution_moves"])
            pos["win"] = "white" if fen[:1].upper() == "W" else "black"
    return pos


# --- module assembly --------------------------------------------------------
_MANUAL_LABEL = {
    "SIJBRANDS": "Sijbrands", "SPRINGER": "Springer",
    "ROOZENBURG": "Roozenburg", "KELLER": "Keller",
}


def _lesson_prose(lesson: dict, lessons_json: dict, sens_json: dict) -> tuple[list[str], list[dict]]:
    """Full master prose for a lesson + any illustrative diagrams (sens-du-jeu)."""
    ch = lesson.get("chapter")
    if ch is not None:
        skey = str(ch)
        if skey in sens_json:
            entry = sens_json[skey]
            return _paras(entry.get("text", "")), list(entry.get("diagrams") or [])
        dkey = str(ch - 200)  # Débutant track: chapters 201.. map to lessons.json 1..
        if dkey in lessons_json:
            return _paras(lessons_json[dkey].get("text", "")), []
    return _paras(lesson.get("intro", "")), []


def build_module(module: dict, level_title: str, ex_idx: dict, diag_idx: dict,
                 lessons_json: dict, sens_json: dict, combi_by_ch: dict) -> dict:
    chapters: list[dict] = []
    blocks: list[dict] = []
    positions: dict[str, dict] = {}

    # Préface (ch 0): module goal.
    chapters.append({"n": 0, "title": "Présentation"})
    blocks.append({"type": "h1", "ch": 0, "runs": [{"t": module["title"]}]})
    if module.get("subtitle"):
        blocks.append({"type": "p", "ch": 0, "runs": [{"t": module["subtitle"]}]})
    if module.get("goal"):
        blocks.append({"type": "p", "ch": 0, "runs": [{"b": 1, "t": "Objectif. "}, {"t": module["goal"]}]})

    for ci, lesson in enumerate(module["lessons"], start=1):
        chapters.append({"n": ci, "title": lesson.get("title") or f"Leçon {ci}"})
        blocks.append({"type": "h2", "ch": ci, "runs": [{"t": lesson.get("title") or f"Leçon {ci}"}]})
        proses, diagrams = _lesson_prose(lesson, lessons_json, sens_json)
        for para in proses:
            blocks.append({"type": "p", "ch": ci, "runs": [{"t": para}]})

        # Débutant reading lessons (chapter 201..) carry only prose; attach the
        # worked combinations of their book chapter (chapter - 200) as boards.
        ch = lesson.get("chapter")
        if ch is not None and str(ch - 200) in lessons_json:
            for ei, ex in enumerate(combi_by_ch.get(ch - 200, [])):
                pid = f"{module['id']}_l{ci}_combi{ei}"
                made = _board_from_exercise(pid, ci, ex, ex.get("name") or "Combinaison",
                                            ex.get("category") or "")
                if made:
                    positions[made["id"]] = made
                    blocks.append({"type": "board", "id": made["id"], "ch": ci})

        # Illustrative sens-du-jeu diagrams (label only, no solution line).
        for di, d in enumerate(diagrams):
            fen = d.get("fen")
            if not fen:
                continue
            pid = f"{module['id']}_l{ci}_dia{di}"
            made = _board_from_position(pid, ci, fen, d.get("label", ""), None)
            if made:
                positions[pid] = made
                blocks.append({"type": "board", "id": pid, "ch": ci})

        # Lesson items: exercises (by name), inline positions, manual pointers.
        for ii, item in enumerate(lesson.get("items", [])):
            kind = item.get("kind")
            if kind == "exercise":
                ex = ex_idx.get(item.get("name"))
                if not ex:
                    continue
                pid = f"{module['id']}_l{ci}_ex{ii}"
                made = _board_from_exercise(pid, ci, ex, item.get("name") or "Exercice",
                                            item.get("theme") or ex.get("category") or "")
            elif kind == "position":
                fen = item.get("fen")
                if not fen:
                    continue
                pid = f"{module['id']}_l{ci}_pos{ii}"
                made = _board_from_position(pid, ci, fen, item.get("theme") or "",
                                            diag_idx.get(item.get("ref")))
            elif kind == "manual":
                src = (item.get("source") or item.get("ref") or "").upper()
                label = _MANUAL_LABEL.get(src, src.title())
                blocks.append({"type": "p", "ch": ci, "runs": [
                    {"t": "Manuel théorique complet : "},
                    {"b": 1, "t": label},
                    {"t": " — à lire dans la section « Manuels théoriques »."},
                ]})
                continue
            else:
                continue
            if made:
                positions[made["id"]] = made
                blocks.append({"type": "board", "id": made["id"], "ch": ci})

    return {
        "book": module["title"],
        "level": level_title,
        "chapters": chapters,
        "blocks": blocks,
        "positions": positions,
    }


def _norm_fen(fen: str) -> tuple:
    """Canonical (turn, frozenset of coloured/kinged squares) for matching a
    diagram FEN to an exercise's initial FEN regardless of square order."""
    parts = (fen or "").split(":")
    pieces = []
    for grp in parts[1:]:
        if not grp:
            continue
        color = grp[0]
        for tok in grp[1:].split(","):
            if tok:
                pieces.append(color + tok)
    return (parts[0] if parts else "", frozenset(pieces))


_ORD = {
    "premier": 1, "première": 1, "deuxième": 2, "second": 2, "seconde": 2,
    "troisième": 3, "quatrième": 4, "cinquième": 5, "sixième": 6, "septième": 7,
    "huitième": 8, "neuvième": 9, "dixième": 10,
}
_REF_RE = re.compile(
    r"(premier|première|deuxième|second[e]?|troisième|quatrième|cinquième|"
    r"sixième|septième|huitième|neuvième|dixième)\s+diagramme"
    r"|diagramme\s+(\d+)|\(?\s*diag\.?\s*(\d+)\s*\)?",
    re.IGNORECASE,
)


def _diagram_refs(text: str) -> list[int]:
    """1-based diagram indices referenced in a paragraph, in order: ordinals
    ("le troisième diagramme") and numbers ("diagramme 3", "(diag. 3)")."""
    out: list[int] = []
    for m in _REF_RE.finditer(text):
        if m.group(1):
            k = _ORD.get(m.group(1).lower())
        else:
            k = int(m.group(2) or m.group(3))
        if k:
            out.append(k)
    return out


def _norm_label(s: str) -> str:
    """Normalise a caption for matching a diagram label to a prose line."""
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


def _lesson_blocks(ch: int, proses: list[str], diagrams: list, ex_rows: list[dict],
                   prefix: str) -> tuple[list[dict], dict[str, dict]]:
    """Lay a chapter out as the masters do: prose with each illustrative diagram
    inserted right where the text refers to it ("le second diagramme …"), then
    the remaining practice exercises. A diagram that matches an exercise FEN
    becomes playable (its verified line attached); exercises already shown as a
    diagram are not repeated."""
    blocks: list[dict] = []
    positions: dict[str, dict] = {}
    ex_by_fen: dict[tuple, dict] = {}
    for ex in ex_rows:
        ex_by_fen.setdefault(_norm_fen(ex["initial_fen"]), ex)
    used: set[tuple] = set()

    # Build the ordered illustrative-diagram boards (playable when matched).
    dia: list[tuple[str, dict] | None] = []
    for i, d in enumerate(diagrams or []):
        fen = d if isinstance(d, str) else (d.get("fen") if isinstance(d, dict) else None)
        if not fen:
            dia.append(None)
            continue
        label = (d.get("label") if isinstance(d, dict) else "") or f"Diagramme {i + 1}"
        pid = f"{prefix}_d{i}"
        key = _norm_fen(fen)
        match = ex_by_fen.get(key)
        if match:
            used.add(key)
            made = _board_from_exercise(pid, ch, match, label, match.get("category") or "")
        else:
            made = _board_from_position(pid, ch, fen, label, None)
        dia.append((pid, made) if made else None)

    placed: set[int] = set()

    def place(k: int) -> None:
        if 1 <= k <= len(dia) and dia[k - 1] and k not in placed:
            placed.add(k)
            _, pos = dia[k - 1]  # type: ignore[misc]
            positions[pos["id"]] = pos
            blocks.append({"type": "board", "id": pos["id"], "ch": ch})

    # Many diagrams are captioned by a concept the prose repeats verbatim as its
    # own line ("L'enchaînement latéral", "Le pion arrière"…). Show the board
    # right there — in caption order for repeated labels — so each labelled
    # advantage carries its illustration instead of a wall of orphaned captions.
    label_q: dict[str, list[int]] = {}
    for i, d in enumerate(diagrams or []):
        lab = d.get("label") if isinstance(d, dict) else None
        if lab and dia[i]:
            label_q.setdefault(_norm_label(lab), []).append(i + 1)

    for para in proses:
        q = label_q.get(_norm_label(para))
        if q:  # this line is a diagram caption → render the board in its place
            place(q.pop(0))
            continue
        blocks.append({"type": "p", "ch": ch, "runs": [{"t": para}]})
        for k in _diagram_refs(para):
            place(k)
    for k in range(1, len(dia) + 1):  # any diagram the prose never referenced
        place(k)

    # Practice exercises not already shown inline as a diagram.
    rem = [ex for ex in ex_rows if _norm_fen(ex["initial_fen"]) not in used]
    if rem:
        blocks.append({"type": "h3", "ch": ch, "runs": [{"t": "Exercices"}]})
        for j, ex in enumerate(rem):
            pid = f"{prefix}_x{j}"
            made = _board_from_exercise(pid, ch, ex, ex.get("name") or "Exercice",
                                        ex.get("category") or "")
            if made:
                positions[made["id"]] = made
                blocks.append({"type": "board", "id": made["id"], "ch": ch})
    return blocks, positions


# --- markdown-authored lesson books (Débutant) ------------------------------
# The Débutant manual is authored in Markdown with authoring scaffolding the
# reader must never see: Scan-validation tables, ``published_notation`` /
# ``final_move.path`` / ``concept`` / ``claude_notes`` cross-references, and
# fixture ids (``BEG_CHnn_mmm``). We parse the Markdown into real reader blocks
# (headings, quotes, lists, bold runs), drop the scaffolding, and drop each
# fixture board in place where its id is cited in the prose — so nothing looks
# like raw Markdown and nothing is invented (boards come from the fixtures).
_MD_HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
_MD_FIXREF = re.compile(r"BEG_CH\d{2}_\d{3}")
_MD_CODE = re.compile(r"`([^`]*)`")
_MD_BOLD = re.compile(r"\*\*(.+?)\*\*")
_MD_HEADING = re.compile(r"(#{2,4})\s+(.*)")
_MD_LIST = re.compile(r"^(?:[-*]|\d+\.)\s+(.*)")
_MD_ORDERED = re.compile(r"^\d+\.\s+")
_MD_SCAFFOLD_TOKENS = ("published_notation", "final_move", "claude_notes", "concept")
# A parenthetical whose content is an authoring cross-reference — drop it whole,
# tolerating one level of nested parentheses (e.g. `(15x31)` cited inside it).
_MD_SCAFFOLD_PAREN = re.compile(
    r"\(\s*(?:cf\.?\s*)?`?(?:final_move|concept|claude_notes)\b"
    r"(?:[^()]|\([^()]*\))*\)", re.I)
# Recurring authoring boilerplate about the Scan-validation process.
_MD_SCAFFOLD_SENTENCE = re.compile(
    r"Toutes les fixtures sont.*?profondeur d['’]analyse\.?", re.I)
# A whole sentence is an authoring note when it mentions the engine pipeline,
# the source-of-truth JSON, or an editor flag — drop it, keep the rest.
_MD_META_SENT = re.compile(
    r"(?:scan_analysis|\bPV\b|moteur Scan|source de vérité|"
    r"reconstructible par le module|verified\b|scan/scan)", re.I)
_MD_SCAFFOLD_CODE = re.compile(
    r"`(?:final_move|concept|claude_notes|published_notation)[^`]*`", re.I)
_MD_SEE = re.compile(r"\b(?:Voir(?:\s+aussi)?|[Cc]f\.?)\s*:\s*")


def _md_runs(text: str) -> list[dict]:
    """Inline runs honouring **bold** (back-ticks already stripped)."""
    runs: list[dict] = []
    i = 0
    for m in _MD_BOLD.finditer(text):
        if m.start() > i:
            runs.append({"t": text[i:m.start()]})
        runs.append({"b": 1, "t": m.group(1)})
        i = m.end()
    if i < len(text):
        runs.append({"t": text[i:]})
    runs = [r for r in runs if r.get("t")]
    return runs or [{"t": text}]


def _md_clean(text: str) -> tuple[str, list[str]]:
    """Strip authoring scaffolding from a line; return (clean_text, fixture_refs
    cited in it). Refs are returned before removal so the board can be placed."""
    refs = _MD_FIXREF.findall(text)
    # Drop whole authoring-note sentences first (boundaries still intact).
    text = " ".join(s for s in re.split(r"(?<=[.!?])\s+", text)
                    if not _MD_META_SENT.search(s))
    text = _MD_SCAFFOLD_SENTENCE.sub("", text)
    text = _MD_SCAFFOLD_PAREN.sub("", text)
    # bare (non-parenthesised) `final_move.path …` span + its trailing
    # "N captures (…)" detail — authoring notes the board already conveys.
    text = re.sub(r"`final_move[^`]*`\s*,?\s*(?:\d+\s+captures?[^.\n)]*\)?)?",
                  "", text, flags=re.I)
    text = re.sub(r"`published_notation`", "Notation", text)  # keep as a label
    text = _MD_SCAFFOLD_CODE.sub("", text)
    text = _MD_FIXREF.sub("", text)
    text = _MD_CODE.sub(lambda m: m.group(1), text)  # keep inner text of `code`
    text = text.replace("`", "")                     # any unmatched back-tick
    # References to the underlying data structure (fixture / explanation /
    # concept / coquille correction ids) — authoring vocabulary, not reader text.
    text = re.sub(r"(?:,\s*)?(?:selon|cf|d['’]apr[eè]s)\s+(?:l['’]|le\s+|la\s+)?"
                  r"(?:explanation|concept)\s+de la fixture", "", text, flags=re.I)
    text = re.sub(r"\b(?:L['’]|Le\s+|La\s+)?(?:explanation|concept)\s+de la fixture",
                  "La combinaison", text, flags=re.I)
    text = re.sub(r"\ble\s+de la fixture\b", "la combinaison", text, flags=re.I)
    text = re.sub(r"\s*\bde la fixture\b", "", text, flags=re.I)
    text = re.sub(r"\bfixtures\b", "combinaisons", text, flags=re.I)
    text = re.sub(r"\bfixture\b", "combinaison", text, flags=re.I)
    text = re.sub(r"(?:,|—|–|-)?\s*coquille(?:\s+PDF)?(?:\s+corrig\w+)?", "", text, flags=re.I)
    text = re.sub(r"\s*(?:cf\s+)?\bR0\d\d\b(?:\s+et\s+R0\d\d)*", "", text, flags=re.I)
    text = _MD_SEE.sub("", text)                     # "Voir <ref> :" leftovers
    text = re.sub(r"[,;—–-]?\s*cf\.?\s*\)", ")", text, flags=re.I)  # ", cf )" dangling
    text = re.sub(r"\(\s*[),]", lambda m: m.group(0)[-1], text)  # "( ," / "()"
    text = re.sub(r"\(\s*(?:à|to|–|—|-|,)?\s*\)", "", text)  # "(à )" from removed refs
    text = re.sub(r"\(\s*\)", "", text)
    text = _MULTISPACE.sub(" ", _WS.sub(" ", text))
    text = re.sub(r"\.\s*,", ".", text)              # "19. , 4" → "19."
    text = re.sub(r"\s+([,.;:!?»])", r"\1", text)
    text = re.sub(r"([«(])\s+", r"\1", text)
    return text.strip(" —–:;,."), refs


def _md_has_content(text: str) -> bool:
    return len(re.sub(r"[^0-9A-Za-zÀ-ÿ]", "", text)) > 1


def _debutant_blocks(ch: int, text: str, diagrams: list, ex_rows: list[dict],
                     prefix: str) -> tuple[list[dict], dict[str, dict]]:
    ex_by_fen: dict[tuple, dict] = {}
    for ex in ex_rows:
        ex_by_fen.setdefault(_norm_fen(ex["initial_fen"]), ex)
    used: set[tuple] = set()

    board_by_ref: dict[str, dict] = {}
    order: list[str] = []
    for i, d in enumerate(diagrams or []):
        if not isinstance(d, dict):
            continue
        fen, ref = d.get("fen"), (d.get("ref") or d.get("label"))
        if not fen or not ref:
            continue
        pid = f"{prefix}_d{i}"
        key = _norm_fen(fen)
        match = ex_by_fen.get(key)
        if match:
            used.add(key)
            made = _board_from_exercise(pid, ch, match, match.get("name") or "Position",
                                        match.get("category") or "")
        else:
            made = _board_from_position(pid, ch, fen, "Position", None)
        if made:
            board_by_ref[ref] = made
            order.append(ref)

    blocks: list[dict] = []
    positions: dict[str, dict] = {}
    placed: set[str] = set()

    def place(ref: str) -> None:
        if ref in board_by_ref and ref not in placed:
            placed.add(ref)
            pos = board_by_ref[ref]
            positions[pos["id"]] = pos
            blocks.append({"type": "board", "id": pos["id"], "ch": ch})

    lines = _MD_HTML_COMMENT.sub("", text).split("\n")
    n = len(lines)
    para: list[str] = []

    def flush() -> None:
        if not para:
            return
        raw = " ".join(para).strip()
        para.clear()
        if (not raw or "🔴" in raw or raw.startswith("**Validation Scan**")
                or "Divergence Scan" in raw or "rédacteur" in raw):
            return
        clean, refs = _md_clean(raw)
        if clean and _md_has_content(clean):
            blocks.append({"type": "p", "ch": ch, "runs": _md_runs(clean)})
        for r in refs:
            place(r)

    i = 0
    while i < n:
        s = lines[i].strip()
        if not s:
            flush()
            i += 1
            continue
        m = _MD_HEADING.match(s)
        if m:
            flush()
            tag = {2: "h2", 3: "h3", 4: "h4"}[len(m.group(1))]
            htext, refs = _md_clean(m.group(2))
            if htext:
                blocks.append({"type": tag, "ch": ch, "runs": _md_runs(htext)})
            for r in refs:
                place(r)
            i += 1
            continue
        if re.match(r"^(?:-{3,}|\*{3,})$", s):  # horizontal rule → drop
            flush()
            i += 1
            continue
        if s.startswith("|"):  # tables here are Scan-validation scaffolding → drop
            flush()
            while i < n and lines[i].strip().startswith("|"):
                i += 1
            continue
        if s.startswith(">"):
            flush()
            q: list[str] = []
            while i < n and lines[i].strip().startswith(">"):
                q.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            qtext = " ".join(x.strip() for x in q).strip()
            if not any(tok in qtext for tok in _MD_SCAFFOLD_TOKENS):
                clean, refs = _md_clean(qtext)
                if clean and _md_has_content(clean):
                    blocks.append({"type": "quote", "ch": ch, "runs": _md_runs(clean)})
                for r in refs:
                    place(r)
            continue
        if _MD_LIST.match(s):
            flush()
            ordered = bool(_MD_ORDERED.match(s))
            item_texts: list[str] = []
            while i < n:
                t = lines[i].strip()
                mm = _MD_LIST.match(t)
                if mm:
                    item_texts.append(mm.group(1))
                elif not t or _MD_HEADING.match(t) or t[:1] in ("|", ">"):
                    break
                elif item_texts:  # continuation line of the current item
                    item_texts[-1] += " " + t
                else:
                    break
                i += 1
            items: list[list[dict]] = []
            list_refs: list[str] = []
            for it_text in item_texts:
                clean, refs = _md_clean(it_text)
                if clean and _md_has_content(clean):
                    items.append(_md_runs(clean))
                list_refs.extend(refs)
            if items:
                blocks.append({"type": "ol" if ordered else "ul", "ch": ch, "items": items})
            for r in list_refs:  # boards after their list, not before it
                place(r)
            continue
        para.append(s)
        i += 1
    flush()

    for ref in order:  # any board the prose never cited → after the text
        place(ref)
    rem = [ex for ex in ex_rows if _norm_fen(ex["initial_fen"]) not in used]
    if rem:
        blocks.append({"type": "h3", "ch": ch, "runs": [{"t": "Exercices"}]})
        for j, ex in enumerate(rem):
            pid = f"{prefix}_x{j}"
            made = _board_from_exercise(pid, ch, ex, ex.get("name") or "Exercice",
                                        ex.get("category") or "")
            if made:
                positions[made["id"]] = made
                blocks.append({"type": "board", "id": made["id"], "ch": ch})
    return blocks, positions


def build_combinaisons_book(lessons_json: dict, combi_by_ch: dict) -> dict:
    """The full Dubois 'Apprendre les combinaisons' book as one reader: its 41
    chapters (lessons.json) each with prose + the chapter's worked combinations
    as playable boards. Opened from the Exercices lesson (📖) button, jumping to
    the requested chapter."""
    chapters: list[dict] = [{"n": 0, "title": "Présentation"}]
    blocks: list[dict] = [
        {"type": "h1", "ch": 0, "runs": [{"t": "Apprendre les combinaisons"}]},
        {"type": "p", "ch": 0, "runs": [{"t": "Méthode de Dubois : 41 chapitres, "
                                              "chacun illustré de combinaisons à jouer ou à résoudre."}]},
    ]
    positions: dict[str, dict] = {}
    for n in sorted(int(k) for k in lessons_json):
        entry = lessons_json[str(n)]
        chapters.append({"n": n, "title": entry.get("title") or f"Chapitre {n}"})
        blocks.append({"type": "h2", "ch": n, "runs": [{"t": entry.get("title") or f"Chapitre {n}"}]})
        b, p = _lesson_blocks(n, _paras(entry.get("text", "")),
                              entry.get("diagrams") or [], combi_by_ch.get(n, []),
                              prefix=f"combi_c{n}")
        blocks.extend(b)
        positions.update(p)
    return {
        "book": "Dubois — Apprendre les combinaisons",
        "level": "Débutant",
        "chapters": chapters,
        "blocks": blocks,
        "positions": positions,
    }


def _ex_by_chapter(rows: list[dict], id_offset: int) -> dict[int, list[dict]]:
    """Group exercise rows by reader chapter (book chapter parsed from the
    description's "Chapitre N", minus the id offset)."""
    by_n: dict[int, list[dict]] = {}
    for ex in rows:
        m = _CHAP_RE.match(ex.get("description", ""))
        if m and ex.get("initial_fen"):
            by_n.setdefault(int(m.group(1)) - id_offset, []).append(ex)
    return by_n


def build_lesson_book(book: str, level: str, chapters_dict: dict, id_offset: int,
                      ex_by_n: dict[int, list[dict]], markdown: bool = False) -> dict:
    """A lesson-prose book (Débutant, Sens du jeu) as one reader: each chapter's
    prose with its illustrative diagrams inlined where the text refers to them,
    then the remaining practice exercises. Chapter ids are mapped to friendly
    numbers via ``id_offset`` (Débutant 0, Sens du jeu 100). ``markdown=True``
    parses Markdown-authored chapters (Débutant) into structured blocks and
    strips authoring scaffolding instead of dumping the prose verbatim."""
    chapters: list[dict] = []
    blocks: list[dict] = []
    positions: dict[str, dict] = {}
    for idStr in sorted(chapters_dict, key=int):
        n = int(idStr) - id_offset
        entry = chapters_dict[idStr]
        chapters.append({"n": n, "title": entry.get("title") or f"Chapitre {n}"})
        blocks.append({"type": "h2", "ch": n, "runs": [{"t": entry.get("title") or f"Chapitre {n}"}]})
        if markdown:
            b, p = _debutant_blocks(n, entry.get("text", ""),
                                    entry.get("diagrams") or [], ex_by_n.get(n, []),
                                    prefix=idStr)
        else:
            b, p = _lesson_blocks(n, _paras(entry.get("text", "")),
                                  entry.get("diagrams") or [], ex_by_n.get(n, []),
                                  prefix=idStr)
        blocks.extend(b)
        positions.update(p)
    return {"book": book, "level": level, "chapters": chapters,
            "blocks": blocks, "positions": positions}


_HEADER = (
    "// Auto-generated by backend/curriculum/build_parcours_manuels.py "
    "— do not edit by hand.\n"
    "import type { ManuelData } from '../ManuelInteractif'\n\n"
)


def _insert_schematics(data: dict, path: Path) -> int:
    """Insert the territorial schematics of the Sens du jeu into a reader,
    aligned with the prose: a chapter's first schematic after its intro
    paragraph, the rest just before each « diagramme ci-dessus » sentence (the
    diagram those sentences refer to sits above them). These annotated empty
    boards carry no position, so they cannot be rendered as playable diagrams —
    they are redrawn on our own board by the viewer's ``SchematicView`` from the
    structured specs in ``sens_du_jeu_schematics.json``."""
    if not path.is_file():
        return 0
    specs_by_ch = {int(k): list(v) for k, v in json.loads(path.read_text()).items() if v}
    if not specs_by_ch:
        return 0

    def text(b: dict) -> str:
        return "".join(r.get("t", "") for r in b.get("runs", []))

    blocks = data["blocks"]
    out: list[dict] = []
    inserted = 0
    i, n = 0, len(blocks)
    while i < n:
        ch = blocks[i].get("ch")
        j = i
        while j < n and blocks[j].get("ch") == ch:
            j += 1
        span = blocks[i:j]
        specs = specs_by_ch.get(ch)
        if specs:
            specs = list(specs)
            first_p = next((k for k, b in enumerate(span) if b.get("type") == "p"), None)
            ci = [k for k, b in enumerate(span)
                  if b.get("type") == "p" and "ci-dessus" in text(b).lower()]
            at: dict[int, list[dict]] = {}

            def sch(spec: dict) -> dict:
                return {"type": "schematic", "ch": ch, "spec": spec}

            if first_p is not None:
                at.setdefault(first_p + 1, []).append(sch(specs.pop(0)))
            for k in ci:
                if not specs:
                    break
                at.setdefault(k, []).append(sch(specs.pop(0)))
            rebuilt: list[dict] = []
            for k, b in enumerate(span):
                rebuilt.extend(at.get(k, []))
                rebuilt.append(b)
            rebuilt.extend(sch(s) for s in specs)  # leftover
            inserted += sum(len(v) for v in at.values()) + len(specs)
            span = rebuilt
        out.extend(span)
        i = j
    data["blocks"] = out
    return inserted


def _write_module(data: dict, module_id: str) -> dict:
    _FRONTEND_DATA.mkdir(parents=True, exist_ok=True)
    body = json.dumps(data, ensure_ascii=False, indent=0)
    out = _FRONTEND_DATA / f"parcours_{module_id}.ts"
    out.write_text(_HEADER + f"const DATA: ManuelData = {body}\n\nexport default DATA\n",
                   encoding="utf-8")
    n_pos = len(data["positions"])
    n_solv = sum(1 for p in data["positions"].values() if p.get("moves"))
    print(f"  {module_id:30s} {len(data['chapters']):3d} ch  {len(data['blocks']):4d} blocks  "
          f"{n_pos:4d} pos ({n_solv} jouables-solution)  {out.stat().st_size // 1024} KiB")
    return {"id": module_id, "book": data["book"], "level": data["level"],
            "n_positions": n_pos}


def _write_registry(metas: list[dict]) -> None:
    lines = [
        "// Auto-generated by backend/curriculum/build_parcours_manuels.py "
        "— do not edit by hand.",
        "import type { ManuelData } from './ManuelInteractif'",
        "",
        "export interface ParcoursManuel {",
        "  id: string",
        "  book: string",
        "  level: string",
        "  load: () => Promise<{ default: ManuelData }>",
        "}",
        "",
        "// Keyed by curriculum module id, so the learning path opens a module",
        "// straight into its interactive reader.",
        "export const PARCOURS_MANUELS: Record<string, ParcoursManuel> = {",
    ]
    for m in metas:
        mid = m["id"]
        lines.append(
            f"  {json.dumps(mid)}: {{ id: {json.dumps(mid)}, book: {json.dumps(m['book'])}, "
            f"level: {json.dumps(m['level'])}, "
            f"load: () => import('./data/parcours_{mid}') }},"
        )
    lines.append("}")
    lines.append("")
    (_FRONTEND_DATA.parent / "parcours.ts").write_text("\n".join(lines), encoding="utf-8")
    print(f"  parcours.ts -> {len(metas)} modules")


def main(argv: list[str]) -> int:
    cur = json.loads((_BACKEND / "curriculum" / "curriculum_resolved.json").read_text())
    lessons_json = json.loads((_BACKEND / "lessons.json").read_text())
    sens_json = json.loads((_BACKEND / "sens_du_jeu_lessons.json").read_text())
    level_title = {lv["id"]: lv["title"] for lv in cur["levels"]}
    ex_idx = _exercise_index()
    diag_idx = _diagram_solution_index()
    combi_by_ch = _combinaisons_by_chapter()

    wanted = set(argv[1:])
    modules = [m for m in cur["modules"] if not wanted or m["id"] in wanted]
    if wanted and not modules:
        print(f"unknown module(s): {wanted}")
        return 2

    print("Building learning-path interactive readers:")
    metas = []
    for m in modules:
        data = build_module(m, level_title.get(m["level"], m["level"]),
                            ex_idx, diag_idx, lessons_json, sens_json, combi_by_ch)
        metas.append(_write_module(data, m["id"]))
    if not wanted:
        # Standalone lesson books opened from the Exercices lesson (📖) button.
        book = build_combinaisons_book(lessons_json, combi_by_ch)
        metas.append(_write_module(book, "manuel_dubois_combinaisons"))

        # Sens du jeu (chapters 101..135 -> reader 1..35). Pure data.
        from sens_du_jeu_loader import sens_du_jeu_chapters  # noqa: PLC0415
        sens_chapters = sens_du_jeu_chapters()
        sens_ex = _ex_by_chapter(_load_py_list("sens_du_jeu_exercises.py",
                                               "SENS_DU_JEU_EXERCISES"), 100)
        sens_book = build_lesson_book("Dubois — Le sens du jeu", "Intermédiaire",
                                      sens_chapters, 100, sens_ex)
        n_sch = _insert_schematics(sens_book, _BACKEND / "sens_du_jeu_schematics.json")
        if n_sch:
            print(f"  (sens du jeu: {n_sch} schémas territoriaux insérés)")
        metas.append(_write_module(sens_book, "manuel_dubois_sens_du_jeu"))

        # Débutant manual (chapters 1..16). Needs dilf (fixtures); skip if absent.
        try:
            from manuels.prose_loader import load_debutant_chapters  # noqa: PLC0415
            from manuels.loader import all_debutant_exercises  # noqa: PLC0415
            deb_chapters = load_debutant_chapters()
            deb_ex = _ex_by_chapter(all_debutant_exercises(), 0)
            deb_book = build_lesson_book("Manuel Débutant", "Débutant",
                                         deb_chapters, 0, deb_ex, markdown=True)
            metas.append(_write_module(deb_book, "manuel_debutant"))
        except Exception as e:  # noqa: BLE001
            print(f"  (skipped manuel_debutant: {e})")

        _write_registry(metas)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
