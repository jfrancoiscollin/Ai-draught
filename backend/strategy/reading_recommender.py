"""Map a game's analysis verdicts to recommended strategic reading.

After a game is analysed, the per-move verdicts carry a phase, structural
features (holes / isolated / backward pawns on each side) and tactical
motifs. This module aggregates those signals **for the user's side** and maps
them — deterministically — to the transversal strategy topics
(``ouverture`` / ``plans`` / ``principes`` / ``pieges`` / ``finales``). Each
topic's precomputed centroid then retrieves its most representative prose
passages.

Why deterministic (no embedding at query time): the deployed backend has no
sentence-transformers encoder (the model is only used offline to build the
corpus sidecars). Topic centroids are means of stored vectors, so we can rank
passages against them at runtime, but we cannot embed a live position. Mapping
analysis signals → topic is therefore a small, explicit table — which is also
exactly what makes the recommendation explainable ("your endgames cost the
most → read Endgame strategy").
"""

from __future__ import annotations

from typing import Any, Iterable

from .topics import get_topic, topic_centroid

# Phase (dilf Phase enum value) → transversal topic key.
_PHASE_TOPIC = {
    "opening": "ouverture",
    "middlegame": "plans",
    "endgame": "finales",
}

# Verdict label (lowercased) → cost weight. Only mistakes count; good moves
# don't tell us what to read.
_VERDICT_WEIGHT = {"blunder": 3.0, "mistake": 2.0, "inaccuracy": 1.0}

# Phase label → human reason, per language.
_PHASE_REASON = {
    "opening": {
        "fr": "L'ouverture t'a coûté le plus de points : revois tes plans d'approche.",
        "en": "Your openings cost the most points: revisit your approach plans.",
    },
    "middlegame": {
        "fr": "Le milieu de partie est ta phase la plus fragile.",
        "en": "The middlegame is your most fragile phase.",
    },
    "endgame": {
        "fr": "Tes finales ont été décisives — à consolider.",
        "en": "Your endgames were decisive — worth consolidating.",
    },
}

_STRUCT_REASON = {
    "fr": "Faiblesses structurelles récurrentes (trous, pions isolés ou arriérés).",
    "en": "Recurring structural weaknesses (holes, isolated or backward pawns).",
}

_TACTIC_REASON = {
    "fr": "Tu as subi ou laissé passer des coups tactiques.",
    "en": "You suffered or missed tactical shots.",
}

# Topic → interactive readers in the Bibliothèque (id = reader entry id the
# frontend can open directly). These are the PDF-extracted books, which are
# not part of the prose-embedding corpus, so they are recommended here by
# topic rather than retrieved by centroid.
_TOPIC_READERS = {
    "ouverture": [
        {"id": "couttet_ouvertures", "book": "Couttet — Étude des ouvertures"},
        {"id": "referentiel_systemes", "book": "Dubois — Référentiel des systèmes de jeu"},
    ],
    "plans": [
        {"id": "enchainements", "book": "Grégoire — Les enchaînements"},
        {"id": "perf_sens_du_jeu_t2", "book": "Dubois — Perfectionnement : le sens du jeu (t.2)"},
    ],
    "principes": [
        {"id": "perf_sens_du_jeu_t1", "book": "Dubois — Perfectionnement : le sens du jeu (t.1)"},
    ],
    "pieges": [
        {"id": "perfectionnement_combinaisons", "book": "Dubois — Perfectionnement : les combinaisons"},
    ],
    "finales": [
        {"id": "fins_de_partie", "book": "Dubois — Apprendre les fins de partie"},
    ],
}


def _aggregate(verdicts: Iterable[Any], user_side: str) -> dict[str, Any]:
    """Sum the user-side cost per phase, structural-weakness counts and the
    number of missed/suffered tactical motifs."""
    phase_cost: dict[str, float] = {"opening": 0.0, "middlegame": 0.0, "endgame": 0.0}
    weakness = 0  # total structural-weakness squares on the user's side
    tactical = 0  # missed/suffered motifs on the user's moves
    n_user_moves = 0

    for v in verdicts:
        if str(getattr(v, "side", "")) != user_side:
            continue
        n_user_moves += 1
        w = _VERDICT_WEIGHT.get(str(getattr(v, "verdict", "")).lower(), 0.0)
        phase = str(getattr(v, "phase", "") or "")
        if w and phase in phase_cost:
            phase_cost[phase] += w
        f = getattr(v, "features_after", None)
        if f is not None:
            for stem in ("holes", "isolated_pawns", "backward_pawns"):
                weakness += len(getattr(f, f"{stem}_{user_side}", []) or [])
        for m in getattr(v, "motifs", []) or []:
            if getattr(m, "role", "") in ("missed", "suffered"):
                tactical += 1

    return {
        "phase_cost": phase_cost,
        "weakness": weakness,
        "tactical": tactical,
        "n_user_moves": n_user_moves,
    }


def _ranked_signals(agg: dict[str, Any], lang: str) -> list[dict[str, Any]]:
    """Turn the aggregates into ranked (topic_key, reason, weight) signals."""
    lg = "en" if lang == "en" else "fr"
    signals: list[dict[str, Any]] = []

    phase_cost: dict[str, float] = agg["phase_cost"]
    worst_phase = max(phase_cost, key=lambda p: phase_cost[p])
    if phase_cost[worst_phase] > 0:
        signals.append({
            "topic_key": _PHASE_TOPIC[worst_phase],
            "reason": _PHASE_REASON[worst_phase][lg],
            "weight": phase_cost[worst_phase],
        })

    n = max(1, agg["n_user_moves"])
    # Structural weakness: a sustained rate (≈ half a flagged square per move).
    if agg["weakness"] / n >= 0.5:
        signals.append({
            "topic_key": "principes",
            "reason": _STRUCT_REASON[lg],
            "weight": agg["weakness"] / n,
        })
    # Tactical exposure: at least a couple of missed/suffered shots.
    if agg["tactical"] >= 2:
        signals.append({
            "topic_key": "pieges",
            "reason": _TACTIC_REASON[lg],
            "weight": float(agg["tactical"]),
        })

    # Highest signal first; dedupe topic keys (keep the strongest reason).
    signals.sort(key=lambda s: -s["weight"])
    seen: set[str] = set()
    out = []
    for s in signals:
        if s["topic_key"] in seen:
            continue
        seen.add(s["topic_key"])
        out.append(s)
    return out


def recommend_reading(
    verdicts: Iterable[Any],
    user_side: str,
    lang: str = "fr",
    max_reco: int = 3,
    per_topic: int = 2,
) -> list[dict[str, Any]]:
    """Return up to ``max_reco`` reading recommendations.

    Each is a transversal strategy topic the game's weaknesses point to, with
    a human reason and the topic's top ``per_topic`` prose passages (the
    centroid's most representative extracts, across all corpora). Empty when
    the game shows no exploitable weakness (e.g. a clean game).
    """
    verdicts = list(verdicts)
    agg = _aggregate(verdicts, user_side)
    signals = _ranked_signals(agg, lang)

    from pedagogy.prose.retrieval import search_with_vector  # noqa: PLC0415

    from .prose_quality import has_prose, lead_excerpt  # noqa: PLC0415

    out: list[dict[str, Any]] = []
    for sig in signals[:max_reco]:
        topic = get_topic(sig["topic_key"])
        centroid = topic_centroid(sig["topic_key"])
        if topic is None or centroid is None:
            continue
        passages = []
        # Over-fetch and keep only readable prose (skip move-score dumps).
        for score, p in search_with_vector(centroid, k=max(per_topic * 8, 40)):
            if not has_prose(p.text):
                continue
            passages.append({
                "passage_id": p.passage_id,
                "source": p.source,
                "book": p.book,
                "page": p.page,
                "text": lead_excerpt(p.text),
                "score": float(score),
            })
            if len(passages) >= per_topic:
                break
        if not passages:
            continue
        out.append({
            "topic_key": topic.key,
            "label_fr": topic.label_fr,
            "label_en": topic.label_en,
            "reason": sig["reason"],
            "passages": passages,
            "readers": _TOPIC_READERS.get(topic.key, []),
        })
    return out
