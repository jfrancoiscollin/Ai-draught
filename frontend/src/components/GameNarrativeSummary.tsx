/**
 * Five cards summarising a finished game's analysis (J4).
 *
 * Backed by GET /api/pedagogy/game/{game_id}/narrative which calls
 * dilf.profile.narrate_game on the persisted verdicts. Each section
 * renders only when the underlying list/dict has content, so a
 * spotless game doesn't show empty placeholder cards.
 *
 *   1. Headline                 — outcome + half-move count + accuracy
 *   2. Phase summary            — opening / middlegame / endgame ACPL
 *   3. Tournants                — top-K worst moves (click → jump board)
 *   4. Faiblesses persistantes  — longest-running structural weaknesses
 *   5. Motifs + drills          — counts + click-to-drill links
 */

import { useEffect, useState } from 'react'
import { getGameNarrative, getRecommendedReading } from '../api/client'
import type {
  GameNarrative,
  PersistentWeakness,
  ReadingRecommendation,
  TurningPoint,
} from '../api/client'
import { useLessonCoverage } from '../hooks/useLessonCoverage'

interface Props {
  gameId: string
  /** Locale forwarded to the narrator. The contract is "fr" today,
   *  "en" supported, anything else silently degrades to fr server-side. */
  lang?: string
  /** Click on a tournant row → jump the board to that half-move.
   *  Wired to the same handler the verdict-list rows use. */
  onJumpTo?: (halfMove: number) => void
  /** Click on a recommended drill chip → open the motif drill page.
   *  Same handler used by PedagogyPanel's motif chips. */
  onMotifClick?: (slug: string) => void
  /** Click on a "joué" / "raté" motif chip → jump the board to the
   *  half-move where that motif fired. Distinct from
   *  ``onMotifClick`` because those chips refer to events that
   *  happened *in this game*, whereas drill chips are
   *  recommendations independent of any particular position. */
  onMotifJump?: (slug: string) => void
  /** Click on a persistent-weakness row → highlight those squares on
   *  the board. Optional — when absent the row stays informational. */
  onWeaknessClick?: (squares: number[]) => void
  /** Click on a 📖 leçon badge → open the matching manuel chapter
   *  as a global overlay. Wired by App.tsx via PedagogyTabsPanel. */
  onOpenLesson?: (chapter: number) => void
  /** Click on a "Lecture recommandée" card → open that source's
   *  long-form strategic manual. Wired by App.tsx. */
  onOpenManual?: (source: string) => void
}

export default function GameNarrativeSummary({
  gameId, lang = 'fr', onJumpTo, onMotifClick, onMotifJump, onWeaknessClick, onOpenLesson, onOpenManual,
}: Props) {
  const [narrative, setNarrative] = useState<GameNarrative | null>(null)
  const [reading, setReading] = useState<ReadingRecommendation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { coverage, openLessonForMotif, openLessonForWeakness } = useLessonCoverage(onOpenLesson)
  const fr = lang !== 'en'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getGameNarrative(gameId, lang)
      .then(n => { if (!cancelled) setNarrative(n) })
      .catch(err => {
        if (cancelled) return
        const status = (err as { response?: { status?: number } })?.response?.status
        // 404 = game never analysed; surface a soft hint rather than
        // an error banner — the user can hit "Analyser la partie".
        if (status === 404) {
          setNarrative(null)
        } else {
          setError(String((err as Error).message ?? err))
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [gameId, lang])

  // Reading recommendations are a soft enrichment: fetched alongside the
  // narrative, failures (incl. 404) just hide the card.
  useEffect(() => {
    let cancelled = false
    getRecommendedReading(gameId, lang)
      .then(r => { if (!cancelled) setReading(r) })
      .catch(() => { if (!cancelled) setReading([]) })
    return () => { cancelled = true }
  }, [gameId, lang])

  if (loading) {
    return (
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-3 text-xs text-gray-400">
        Chargement du résumé…
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-gray-800/50 border border-red-800/40 rounded-xl p-3 text-xs text-red-400">
        Erreur : {error}
      </div>
    )
  }
  if (!narrative) return null

  return (
    <div className="flex flex-col gap-2">
      {/* 1. Headline */}
      <div className="bg-gray-800/60 border border-amber-700/40 rounded-xl px-3 py-2">
        <p className="text-base font-bold text-amber-300">{narrative.headline}</p>
      </div>

      {/* 2. Phase summary */}
      {narrative.phase_summary.length > 0 && (
        <div className="bg-gray-800/40 border border-gray-700 rounded-xl px-3 py-2">
          <p className="text-xs font-semibold text-gray-300 mb-1.5">Par phase</p>
          <div className="flex flex-col gap-0.5 text-xs text-gray-300">
            {narrative.phase_summary.map(p => (
              <p key={p.phase}>{p.summary}</p>
            ))}
          </div>
        </div>
      )}

      {/* 3. Turning points */}
      {narrative.turning_points.length > 0 && (
        <div className="bg-gray-800/40 border border-gray-700 rounded-xl px-3 py-2">
          <p className="text-xs font-semibold text-gray-300 mb-1.5">Tournants de la partie</p>
          <div className="flex flex-col gap-1.5">
            {narrative.turning_points.map(tp => (
              <TurningPointRow key={tp.move_number} tp={tp} onJumpTo={onJumpTo} />
            ))}
          </div>
        </div>
      )}

      {/* 4. Persistent weaknesses */}
      {narrative.persistent_weaknesses.length > 0 && (
        <div className="bg-gray-800/40 border border-gray-700 rounded-xl px-3 py-2">
          <p className="text-xs font-semibold text-gray-300 mb-1.5">Faiblesses persistantes</p>
          <div className="flex flex-col gap-1 text-xs">
            {narrative.persistent_weaknesses.map((w, i) => (
              <WeaknessRow
                key={i}
                w={w}
                onClick={onWeaknessClick}
                onOpenLesson={coverage.weaknesses.has(w.family) ? openLessonForWeakness : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* 5. Motifs + drills */}
      {(Object.keys(narrative.motifs_played).length > 0
        || Object.keys(narrative.motifs_missed).length > 0
        || narrative.strengths.length > 0) && (
        <div className="bg-gray-800/40 border border-gray-700 rounded-xl px-3 py-2 flex flex-col gap-2">
          {narrative.strengths.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-300 mb-1">Points forts</p>
              <ul className="text-xs text-gray-300 list-disc pl-4">
                {narrative.strengths.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {Object.keys(narrative.motifs_played).length > 0 && (
            <MotifChipRow
              label="Motifs joués"
              counts={narrative.motifs_played}
              colour="green"
              onClick={onMotifJump}
              coveredSlugs={coverage.motifs}
              onOpenLesson={openLessonForMotif}
            />
          )}
          {Object.keys(narrative.motifs_missed).length > 0 && (
            <MotifChipRow
              label="Motifs ratés"
              counts={narrative.motifs_missed}
              colour="red"
              onClick={onMotifJump}
              coveredSlugs={coverage.motifs}
              onOpenLesson={openLessonForMotif}
            />
          )}
          {narrative.recommended_drills.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-300 mb-1">
                À travailler
              </p>
              <div className="flex flex-wrap gap-1">
                {narrative.recommended_drills.map(slug => (
                  <span key={slug} className="inline-flex items-stretch rounded overflow-hidden">
                    <button
                      onClick={() => onMotifClick?.(slug)}
                      disabled={!onMotifClick}
                      className="px-1.5 py-0.5 text-xs bg-amber-700/30 text-amber-200 hover:bg-amber-700/50 disabled:opacity-50 cursor-pointer disabled:cursor-default"
                      title="Ouvrir la page de drill"
                    >
                      {slug.replace(/_/g, ' ')} →
                    </button>
                    {coverage.motifs.has(slug) && onOpenLesson && (
                      <button
                        onClick={() => openLessonForMotif(slug)}
                        className="px-1.5 py-0.5 text-xs bg-amber-700/50 text-amber-100 hover:bg-amber-700/70 cursor-pointer border-l border-amber-900/50"
                        title="Ouvrir la leçon correspondante"
                      >
                        📖
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 6. Lecture recommandée — strategic prose this game points to. */}
      {reading.length > 0 && (
        <div className="bg-gray-800/40 border border-amber-700/40 rounded-xl px-3 py-2 flex flex-col gap-2">
          <p className="text-xs font-semibold text-amber-300">
            {fr ? '📚 Lecture recommandée' : '📚 Recommended reading'}
          </p>
          {reading.map(rec => {
            const top = rec.passages[0]
            return (
              <div key={rec.topic_key} className="rounded-lg border border-gray-700 bg-gray-900/40 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-100">
                    {fr ? rec.label_fr : rec.label_en}
                  </span>
                  {top && onOpenManual && (
                    <button
                      onClick={() => onOpenManual(top.source)}
                      className="shrink-0 px-1.5 py-0.5 text-xs rounded bg-amber-700/40 text-amber-100 hover:bg-amber-700/60 cursor-pointer"
                      title={fr ? 'Ouvrir le manuel' : 'Open the manual'}
                    >
                      {fr ? 'Lire' : 'Read'} →
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-gray-400 mt-0.5">{rec.reason}</p>
                {top && (
                  <p className="text-[11px] text-gray-500 mt-1 line-clamp-2 italic">
                    « {top.text.slice(0, 160).trim()}… » — {top.source}
                  </p>
                )}
                {(rec.readers?.length ?? 0) > 0 && onOpenManual && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {rec.readers!.map(r => (
                      <button
                        key={r.id}
                        onClick={() => onOpenManual(r.id)}
                        className="px-1.5 py-0.5 text-[11px] rounded bg-gray-700/60 text-gray-200 hover:bg-amber-700/50 hover:text-amber-100 cursor-pointer"
                        title={fr ? 'Ouvrir dans la Bibliothèque' : 'Open in the Library'}
                      >
                        📖 {r.book}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────

function TurningPointRow({
  tp, onJumpTo,
}: {
  tp: TurningPoint
  onJumpTo?: (halfMove: number) => void
}) {
  const sideLabel = tp.side === 'white' ? '⬜' : '⬛'
  return (
    <button
      onClick={() => onJumpTo?.(tp.move_number)}
      disabled={!onJumpTo}
      className="text-left text-xs px-2 py-1 rounded hover:bg-gray-700/60 disabled:cursor-default cursor-pointer flex items-center gap-2"
      title={onJumpTo ? 'Aller à cette position' : undefined}
    >
      <span className="font-mono text-gray-200 w-16 flex-shrink-0">
        {sideLabel} {tp.notation}
      </span>
      <span className="font-bold text-red-400 w-12 flex-shrink-0">
        -{tp.delta_cp}cp
      </span>
      <span className="text-gray-300 flex-1 min-w-0 truncate">{tp.reason}</span>
    </button>
  )
}

function WeaknessRow({
  w, onClick, onOpenLesson,
}: {
  w: PersistentWeakness
  onClick?: (squares: number[]) => void
  onOpenLesson?: (family: string) => void
}) {
  return (
    <div className="flex items-stretch gap-1">
      <button
        onClick={() => onClick?.([w.square])}
        disabled={!onClick}
        className="flex-1 text-left text-xs px-2 py-1 rounded hover:bg-gray-700/60 disabled:cursor-default cursor-pointer text-gray-300"
        title={onClick ? `Surligner la case ${w.square}` : undefined}
      >
        {w.summary}
      </button>
      {onOpenLesson && (
        <button
          onClick={() => onOpenLesson(w.family)}
          className="px-1.5 rounded text-xs bg-gray-700/40 text-gray-200 hover:bg-gray-700/80 cursor-pointer flex-shrink-0"
          title="Ouvrir la leçon correspondante"
        >
          📖
        </button>
      )}
    </div>
  )
}

function MotifChipRow({
  label, counts, colour, onClick, coveredSlugs, onOpenLesson,
}: {
  label: string
  counts: Record<string, number>
  colour: 'green' | 'red'
  onClick?: (slug: string) => void
  /** Slugs for which a lesson exists; chips outside this set get no 📖 badge. */
  coveredSlugs?: Set<string>
  onOpenLesson?: (slug: string) => void
}) {
  const bg = colour === 'green' ? 'bg-green-700/30 text-green-200 hover:bg-green-700/50'
                                 : 'bg-red-700/30 text-red-200 hover:bg-red-700/50'
  const badgeBg = colour === 'green' ? 'bg-green-700/60 text-green-100 hover:bg-green-700/90 border-green-900/50'
                                      : 'bg-red-700/60 text-red-100 hover:bg-red-700/90 border-red-900/50'
  return (
    <div>
      <p className="text-xs font-semibold text-gray-300 mb-1">{label}</p>
      <div className="flex flex-wrap gap-1">
        {Object.entries(counts).map(([slug, n]) => {
          const covered = coveredSlugs?.has(slug) && !!onOpenLesson
          return (
            <span key={slug} className="inline-flex items-stretch rounded overflow-hidden">
              <button
                onClick={() => onClick?.(slug)}
                disabled={!onClick}
                className={`px-1.5 py-0.5 text-xs ${bg} disabled:opacity-50 cursor-pointer disabled:cursor-default`}
                title={onClick ? 'Aller à la position où ce motif a joué' : undefined}
              >
                {slug.replace(/_/g, ' ')} <span className="font-mono">×{n}</span>
              </button>
              {covered && (
                <button
                  onClick={() => onOpenLesson!(slug)}
                  className={`px-1.5 py-0.5 text-xs ${badgeBg} cursor-pointer border-l`}
                  title="Ouvrir la leçon correspondante"
                >
                  📖
                </button>
              )}
            </span>
          )
        })}
      </div>
    </div>
  )
}
