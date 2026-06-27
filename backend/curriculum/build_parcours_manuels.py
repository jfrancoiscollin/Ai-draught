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
        for para in _paras(entry.get("text", "")):
            blocks.append({"type": "p", "ch": n, "runs": [{"t": para}]})
        for ei, ex in enumerate(combi_by_ch.get(n, [])):
            pid = f"combi_c{n}_e{ei}"
            made = _board_from_exercise(pid, n, ex, ex.get("name") or "Combinaison",
                                        ex.get("category") or "")
            if made:
                positions[made["id"]] = made
                blocks.append({"type": "board", "id": made["id"], "ch": n})
    return {
        "book": "Dubois — Apprendre les combinaisons",
        "level": "Débutant",
        "chapters": chapters,
        "blocks": blocks,
        "positions": positions,
    }


_HEADER = (
    "// Auto-generated by backend/curriculum/build_parcours_manuels.py "
    "— do not edit by hand.\n"
    "import type { ManuelData } from '../ManuelInteractif'\n\n"
)


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
        # Standalone book opened from the Exercices lesson (📖) button.
        book = build_combinaisons_book(lessons_json, combi_by_ch)
        metas.append(_write_module(book, "manuel_dubois_combinaisons"))
        _write_registry(metas)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
