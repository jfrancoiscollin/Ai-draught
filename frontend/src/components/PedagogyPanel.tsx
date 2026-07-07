import React, { useState, useCallback, useEffect, useRef } from 'react'
import type { ExplainResult, HeatmapNarrative, PedagogyAnalysis, SquareWeaknessCounts, VerdictOut } from '../api/client'
import { explainMovePedagogy, narrateHeatmap } from '../api/client'
import {
  HeatmapBoard,
  HeatMetricSelector,
  type HeatMetric,
} from './HeatmapBoard'

interface Props {
  gameId: string
  analysis: PedagogyAnalysis | null
  loading: boolean
  userSide: 'white' | 'black'
  lang: string
  onAnalyze: () => void
  error?: string | null
  onMotifClick?: (slug: string) => void
  /** Currently displayed half-move on the board (0 = initial position,
   *  1 = after the first move, etc.). Used to highlight & auto-scroll
   *  the matching verdict row. */
  currentHalfMove?: number
  /** Called when the user clicks a verdict row to jump the board to
   *  that half-move. Receives the verdict's ``move_number``. */
  onJumpTo?: (halfMove: number) => void
}

// ── Verdict styling ────────────────────────────────────────────────────────

const VERDICT_LABEL: Record<VerdictOut['verdict'], string> = {
  brilliant:  '!!',
  best:       '✓',
  excellent:  '✓',
  good:       '!',
  inaccuracy: '?!',
  mistake:    '?',
  blunder:    '??',
  forced:     '—',
  book:       '≡',
}

export const VERDICT_COLOR: Record<VerdictOut['verdict'], string> = {
  brilliant:  '#f59e0b',
  best:       '#22c55e',
  excellent:  '#34d399',
  good:       '#86efac',
  inaccuracy: '#fbbf24',
  mistake:    '#f97316',
  blunder:    '#ef4444',
  forced:     '#6b7280',
  book:       '#818cf8',
}

export const VERDICT_FR: Record<VerdictOut['verdict'], string> = {
  brilliant:  'Brillant',
  best:       'Meilleur coup',
  excellent:  'Excellent',
  good:       'Bon',
  inaccuracy: 'Imprécision',
  mistake:    'Erreur',
  blunder:    'Gaffe',
  forced:     'Forcé',
  book:       'Théorie',
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Format a score (pawn units, white's perspective) as a signed string. */
function fmtScore(scoreWhitePerspective: number): string {
  const sign = scoreWhitePerspective >= 0 ? '+' : ''
  return `${sign}${scoreWhitePerspective.toFixed(2)}`
}

/** Centipawn loss for one move (same formula as scan_advisor). */
function cpLoss(v: VerdictOut): number {
  return Math.round(Math.max(v.delta_winchance, 0) * 100)
}

/** Average centipawn loss across a set of verdicts. */
function acpl(vs: VerdictOut[]): number {
  const movable = vs.filter(v => v.verdict !== 'forced' && v.verdict !== 'book')
  if (!movable.length) return 0
  return Math.round(movable.reduce((s, v) => s + cpLoss(v), 0) / movable.length)
}

// ── Sub-components ─────────────────────────────────────────────────────────

// ── Material timeline ─────────────────────────────────────────────────────
// Compact line chart of material_balance and score_before across the
// game. White-perspective Y axis: above zero = white ahead. Clicking a
// column jumps the board to that half-move (same contract as the move
// rows). Score is clipped to ±5 pawns so a single mate-bound eval
// doesn't squash the whole curve flat.

export function MaterialTimeline({
  verdicts, currentHalfMove, onJumpTo,
}: {
  verdicts: VerdictOut[]
  currentHalfMove?: number
  onJumpTo?: (hm: number) => void
}) {
  if (verdicts.length < 2) return null
  const W = 280
  const H = 56
  const PAD_X = 4
  const PAD_Y = 6
  const innerW = W - 2 * PAD_X
  const innerH = H - 2 * PAD_Y

  const mats = verdicts.map(v => v.material_balance ?? 0)
  const scores = verdicts.map(v => Math.max(-5, Math.min(5, v.score_before)))
  const yMax = Math.max(2, ...mats.map(Math.abs), ...scores.map(Math.abs))

  const xFor = (i: number) => PAD_X + (i / (verdicts.length - 1)) * innerW
  const yFor = (val: number) => PAD_Y + (1 - (val + yMax) / (2 * yMax)) * innerH
  const yZero = yFor(0)

  const matPath = mats.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(v)}`).join(' ')
  const scoPath = scores.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(v)}`).join(' ')

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onJumpTo) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const ratio = (px / rect.width) * (W / W)  // identity, viewBox = W
    const i = Math.round((ratio - PAD_X / W) * (verdicts.length - 1))
    const clamped = Math.max(0, Math.min(verdicts.length - 1, i))
    onJumpTo(verdicts[clamped].move_number)
  }

  const cursorX = currentHalfMove
    ? xFor(Math.max(0, verdicts.findIndex(v => v.move_number === currentHalfMove)))
    : null

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-gray-600 w-4 text-right tabular-nums" title="Échelle Y">±{yMax}</span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onClick={handleClick}
        className="flex-1 cursor-pointer"
        style={{ height: H, background: 'rgba(0,0,0,0.2)', borderRadius: 4 }}
      >
        {/* Zero baseline */}
        <line x1={PAD_X} y1={yZero} x2={W - PAD_X} y2={yZero} stroke="#4b5563" strokeWidth={0.5} strokeDasharray="2 2" />
        {/* Score (Scan) — thin secondary */}
        <path d={scoPath} fill="none" stroke="#6366f1" strokeWidth={1} opacity={0.55} />
        {/* Material — main signal */}
        <path d={matPath} fill="none" stroke="#fbbf24" strokeWidth={1.5} />
        {/* Current cursor */}
        {cursorX !== null && cursorX !== undefined && (
          <line x1={cursorX} y1={PAD_Y} x2={cursorX} y2={H - PAD_Y} stroke="#f59e0b" strokeWidth={1} opacity={0.9} />
        )}
      </svg>
    </div>
  )
}

// ── Per-game weakness persistence ─────────────────────────────────────────
// Aggregates the same 4 geometric families as the cross-game heatmap, but
// only over the verdicts of the currently-open game. Filtered to the
// user's own side.
//
// IMPORTANT — what this counts. The naive approach (increment per
// half-move occurrence) measures *duration*: a hole that stays on
// square 23 for 40 half-moves contributes 40 to the count, even though
// it's the same hole. That inflates persistent issues out of all
// proportion to distinct ones.
//
// Instead, we count *streaks*: a contiguous run of half-moves where a
// (square, metric) pair is active counts as 1. A hole-on-23 that
// disappears and re-appears later counts as 2. This is the meaningful
// "how many distinct weaknesses did I have on this square" reading.
//
// For the duration view (which is also useful pedagogically — a
// long-lived weakness is worth flagging), see the Gantt panel below.

function aggregateGameHeatmap(
  verdicts: VerdictOut[],
  userSide: 'white' | 'black',
): Record<string, SquareWeaknessCounts> {
  const by: Record<string, SquareWeaknessCounts> = {}
  const suffix = userSide === 'white' ? 'white' : 'black'
  const lists: Array<{ key: keyof SquareWeaknessCounts; pick: (v: VerdictOut) => number[] }> = [
    { key: 'isolated', pick: v => (v as any)[`isolated_pawns_${suffix}`] ?? [] },
    { key: 'backward', pick: v => (v as any)[`backward_pawns_${suffix}`] ?? [] },
    { key: 'holes',    pick: v => (v as any)[`holes_${suffix}`] ?? [] },
    { key: 'outposts', pick: v => (v as any)[`outposts_${suffix}`] ?? [] },
  ]
  for (const { key, pick } of lists) {
    let prev = new Set<number>()
    for (const v of verdicts) {
      const curr = new Set<number>(pick(v))
      for (const sq of curr) {
        if (prev.has(sq)) continue
        const bucket = by[String(sq)] ?? { isolated: 0, backward: 0, holes: 0, outposts: 0 }
        bucket[key] += 1
        by[String(sq)] = bucket
      }
      prev = curr
    }
  }
  return by
}

export function GameHeatmap({
  verdicts, userSide,
}: {
  verdicts: VerdictOut[]
  userSide: 'white' | 'black'
}) {
  const [metric, setMetric] = useState<HeatMetric>('all')
  // Default to open: the cross-game variant is permanently visible at
  // the bottom of WeaknessPanel, so the per-game counterpart should
  // match — making it discoverable on first land instead of buried
  // behind a small disclosure triangle.
  const [open, setOpen] = useState(true)
  const [narratives, setNarratives] = useState<Record<string, HeatmapNarrative | null> | null>(null)
  const bySquare = aggregateGameHeatmap(verdicts, userSide)
  const total = Object.values(bySquare).reduce(
    (s, b) => s + b.isolated + b.backward + b.holes + b.outposts, 0,
  )

  // Lazy-fetch narratives the first time the panel opens for this
  // verdict set. Re-fetch when verdicts identity changes (a re-analysis
  // returns a new array) so the captions don't go stale. Failure is
  // non-fatal — we just hide the narrative block.
  useEffect(() => {
    if (!open || total === 0) return
    let cancelled = false
    narrateHeatmap(bySquare)
      .then(n => { if (!cancelled) setNarratives(n) })
      .catch(() => { if (!cancelled) setNarratives(null) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bySquare
    // is rebuilt every render; we only want the fetch on open / verdicts.
  }, [open, verdicts])

  if (verdicts.length === 0) return null

  const narrative = narratives?.[metric]
  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-0 p-0 text-left"
      >
        <span>
          {open ? '▾' : '▸'} Faiblesses distinctes ({userSide === 'white' ? '⬜' : '⬛'})
        </span>
        <span className="text-gray-600">
          {total === 0 ? 'pas de données' : `${total} occurrences`}
        </span>
      </button>
      {open && total === 0 && (
        <p className="text-xs text-gray-500 italic">
          Aucune faiblesse géométrique détectée sur cette partie — soit le placement
          est resté propre, soit la partie a été analysée avant l'arrivée de la
          carte par-partie (relance "🎓 Analyser la partie" pour rafraîchir).
        </p>
      )}
      {open && total > 0 && (
        <>
          <HeatMetricSelector value={metric} onChange={setMetric} />
          <HeatmapBoard bySquare={bySquare} metric={metric} maxWidth={220} />
          {narrative && (
            <div className="flex flex-col gap-1 text-xs">
              <p className="text-gray-400">
                <span className="text-gray-600">Top cases : </span>
                <span className="font-mono text-gray-200">{narrative.top_line}</span>
              </p>
              {narrative.hint && (
                <p className="text-gray-400 leading-relaxed">{narrative.hint}</p>
              )}
            </div>
          )}
          <p className="text-xs text-gray-600 leading-relaxed">
            {verdicts.length} demi-coups · une faiblesse persistante = 1 occurrence
            (réapparaît après interruption = +1). Voir le Gantt ci-dessous pour
            la durée réelle.
          </p>
        </>
      )}
    </div>
  )
}

// ── Per-game weakness Gantt ───────────────────────────────────────────────
// Companion to the streak-deduped heatmap above: shows *when* each
// (square, metric) was active in the game. Each row is a (square,
// metric) pair; each bar is a contiguous streak. Same colour palette
// as the corner-dot flags on the board.

type GanttStreak = { metric: HeatMetric; startIdx: number; endIdx: number }

function computeGanttStreaks(
  verdicts: VerdictOut[],
  userSide: 'white' | 'black',
): Map<number, GanttStreak[]> {
  const out = new Map<number, GanttStreak[]>()
  const suffix = userSide === 'white' ? 'white' : 'black'
  const families: Array<{ metric: Exclude<HeatMetric, 'all'>; pick: (v: VerdictOut) => number[] }> = [
    { metric: 'isolated', pick: v => (v as any)[`isolated_pawns_${suffix}`] ?? [] },
    { metric: 'backward', pick: v => (v as any)[`backward_pawns_${suffix}`] ?? [] },
    { metric: 'holes',    pick: v => (v as any)[`holes_${suffix}`] ?? [] },
    { metric: 'outposts', pick: v => (v as any)[`outposts_${suffix}`] ?? [] },
  ]
  // Track open streaks: (sq, metric) -> startIdx. When the square
  // disappears from the metric, close the streak; when it reappears,
  // open a fresh one. End of verdicts closes everything still open.
  type Key = string
  const openStarts = new Map<Key, number>()
  const k = (sq: number, m: HeatMetric) => `${m}:${sq}`

  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i]
    const seenThisVerdict = new Set<Key>()
    for (const { metric, pick } of families) {
      for (const sq of pick(v)) {
        const key = k(sq, metric)
        seenThisVerdict.add(key)
        if (!openStarts.has(key)) openStarts.set(key, i)
      }
    }
    // Close any streak that was open last verdict but isn't here now.
    for (const [key, start] of [...openStarts.entries()]) {
      if (seenThisVerdict.has(key)) continue
      const [metric, sqStr] = key.split(':')
      const sq = Number(sqStr)
      const streaks = out.get(sq) ?? []
      streaks.push({ metric: metric as HeatMetric, startIdx: start, endIdx: i - 1 })
      out.set(sq, streaks)
      openStarts.delete(key)
    }
  }
  // Close anything still open at end-of-game.
  for (const [key, start] of openStarts) {
    const [metric, sqStr] = key.split(':')
    const sq = Number(sqStr)
    const streaks = out.get(sq) ?? []
    streaks.push({ metric: metric as HeatMetric, startIdx: start, endIdx: verdicts.length - 1 })
    out.set(sq, streaks)
  }
  return out
}

const GANTT_COLORS: Record<Exclude<HeatMetric, 'all'>, string> = {
  isolated: '#06b6d4',
  backward: '#f59e0b',
  holes:    '#a855f7',
  outposts: '#22c55e',
}

export function WeaknessGantt({
  verdicts, userSide,
}: {
  verdicts: VerdictOut[]
  userSide: 'white' | 'black'
}) {
  // Open by default — the heatmap above answers "where", the Gantt
  // answers "when and for how long", and the latter is often the
  // more pedagogically actionable read.
  const [open, setOpen] = useState(true)
  const [filter, setFilter] = useState<HeatMetric>('all')

  if (verdicts.length < 2) return null
  const streaks = computeGanttStreaks(verdicts, userSide)
  if (streaks.size === 0) return null

  // One row per square. Rank by total streak duration desc so the
  // most pedagogically interesting (long-lived weaknesses) come first.
  const rows = [...streaks.entries()]
    .map(([sq, ss]) => {
      const filtered = filter === 'all' ? ss : ss.filter(s => s.metric === filter)
      const dur = filtered.reduce((s, x) => s + (x.endIdx - x.startIdx + 1), 0)
      return { sq, streaks: filtered, dur }
    })
    .filter(r => r.streaks.length > 0)
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 12)

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <button
          onClick={() => setOpen(v => !v)}
          className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-0 p-0 text-left"
        >
          <span>{open ? '▾' : '▸'} Durée des faiblesses (Gantt)</span>
          <span className="text-gray-600">pas de données</span>
        </button>
        {open && (
          <p className="text-xs text-gray-500 italic">
            Aucune faiblesse de la famille « {HEAT_FILTER_LABEL[filter]} » sur cette partie.
          </p>
        )}
      </div>
    )
  }

  const N = verdicts.length
  const W = 280
  const ROW_H = 14
  const LABEL_W = 28

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs text-gray-400 hover:text-gray-200 cursor-pointer bg-transparent border-0 p-0 text-left"
      >
        <span>{open ? '▾' : '▸'} Durée des faiblesses (Gantt)</span>
        <span className="text-gray-600">
          {rows.length} case{rows.length > 1 ? 's' : ''} · {N} demi-coups
        </span>
      </button>
      {open && (
        <>
          <div className="flex gap-1 flex-wrap">
            {(['all', 'isolated', 'backward', 'holes', 'outposts'] as const).map(m => (
              <button
                key={m}
                onClick={() => setFilter(m)}
                className={
                  'px-1.5 py-0.5 rounded text-xs transition-colors ' +
                  (filter === m
                    ? 'bg-amber-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600 cursor-pointer')
                }
              >
                {HEAT_FILTER_LABEL[m]}
              </button>
            ))}
          </div>
          <svg
            viewBox={`0 0 ${W} ${rows.length * ROW_H + 14}`}
            preserveAspectRatio="none"
            style={{ width: '100%', maxWidth: 320, background: 'rgba(0,0,0,0.2)', borderRadius: 4 }}
          >
            {/* X-axis ticks */}
            {[0, 0.25, 0.5, 0.75, 1].map(t => {
              const x = LABEL_W + t * (W - LABEL_W)
              return (
                <g key={t}>
                  <line x1={x} y1={0} x2={x} y2={rows.length * ROW_H + 14}
                    stroke="#374151" strokeWidth={0.4} />
                  <text x={x} y={rows.length * ROW_H + 12}
                    fontSize={8} fill="#6b7280" textAnchor="middle">
                    {Math.round(t * N)}
                  </text>
                </g>
              )
            })}
            {rows.map((r, i) => {
              const y = i * ROW_H
              return (
                <g key={r.sq}>
                  <text x={LABEL_W - 4} y={y + ROW_H * 0.7}
                    fontSize={9} fill="#d1d5db" textAnchor="end" fontFamily="monospace">
                    {r.sq}
                  </text>
                  <line x1={LABEL_W} y1={y + ROW_H / 2} x2={W} y2={y + ROW_H / 2}
                    stroke="#1f2937" strokeWidth={0.5} />
                  {r.streaks.map((s, k) => {
                    const x1 = LABEL_W + (s.startIdx / Math.max(N - 1, 1)) * (W - LABEL_W)
                    const x2 = LABEL_W + (s.endIdx   / Math.max(N - 1, 1)) * (W - LABEL_W)
                    return (
                      <rect
                        key={k}
                        x={x1} y={y + 2}
                        width={Math.max(2, x2 - x1)} height={ROW_H - 4}
                        rx={1.5}
                        fill={GANTT_COLORS[s.metric as Exclude<HeatMetric, 'all'>]}
                        opacity={0.85}
                      >
                        <title>
                          case {r.sq} · {HEAT_FILTER_LABEL[s.metric]} ·
                          demi-coups {s.startIdx + 1}–{s.endIdx + 1}
                          ({s.endIdx - s.startIdx + 1} demi-coups)
                        </title>
                      </rect>
                    )
                  })}
                </g>
              )
            })}
          </svg>
          <p className="text-xs text-gray-600">
            Une ligne par case · barres = streaks contigus · trier par durée totale ·
            top 12. Couleurs = mêmes que les pastilles du diagnostic.
          </p>
        </>
      )}
    </div>
  )
}

const HEAT_FILTER_LABEL: Record<HeatMetric, string> = {
  all: 'Toutes', isolated: 'Isolés', backward: 'Retardés', holes: 'Trous', outposts: 'Postes',
}

export function AccuracyBar({ accuracy }: { accuracy: number }) {
  const pct = Math.round(accuracy * 100)
  const color = pct >= 90 ? '#22c55e' : pct >= 75 ? '#86efac' : pct >= 60 ? '#fbbf24' : '#ef4444'
  return (
    <div className="flex items-center gap-2 flex-1">
      <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-xs font-bold tabular-nums" style={{ color }}>{pct}%</span>
    </div>
  )
}

function VerdictBadge({ verdict }: { verdict: VerdictOut['verdict'] }) {
  return (
    <span
      className="inline-block w-6 text-center font-bold text-xs flex-shrink-0"
      style={{ color: VERDICT_COLOR[verdict] }}
      title={VERDICT_FR[verdict]}
    >
      {VERDICT_LABEL[verdict]}
    </span>
  )
}

export function MoveRow({
  verdict, gameId, lang, onMotifClick, isActive, onJump,
}: {
  verdict: VerdictOut
  gameId: string
  lang: string
  onMotifClick?: (slug: string) => void
  isActive: boolean
  onJump?: (halfMove: number) => void
}) {
  // Expanded by default — the user asked for the explanation block
  // to be visible without clicking. The fetch fires lazily through an
  // IntersectionObserver below so a 100-move game doesn't burst-call
  // the /explain-move endpoint past its 60/min rate limit; rows that
  // never scroll into view never trigger a request.
  const [expanded, setExpanded] = useState(true)
  const [explanation, setExplanation] = useState<ExplainResult | null>(null)
  const [loadingExpl, setLoadingExpl] = useState(false)
  const rowRef = useRef<HTMLDivElement | null>(null)

  // Scroll the active row into view whenever the board navigation moves
  // to a different half-move. ``nearest`` avoids jumping the page when
  // the row is already visible.
  useEffect(() => {
    if (isActive && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [isActive])

  const fetchExplanation = useCallback(async () => {
    if (explanation === null) {
      setLoadingExpl(true)
      const result = await explainMovePedagogy(gameId, verdict.move_number, 'template', lang)
      setExplanation(result)
      setLoadingExpl(false)
    }
  }, [explanation, gameId, verdict.move_number, lang])

  // Lazy-fetch the explanation the first time the row scrolls into view
  // (and is expanded). Avoids the burst that would happen if every row
  // fetched on mount. Once fetched, the result is cached locally and
  // the observer can disconnect.
  useEffect(() => {
    if (!expanded || explanation !== null || loadingExpl) return
    const el = rowRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      // Fallback: fetch immediately (e.g. jsdom in vitest).
      void fetchExplanation()
      return
    }
    const obs = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          void fetchExplanation()
          obs.disconnect()
          break
        }
      }
    }, { rootMargin: '40px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [expanded, explanation, loadingExpl, fetchExplanation])

  const handleRowClick = useCallback(() => {
    onJump?.(verdict.move_number)
  }, [onJump, verdict.move_number])

  const handleToggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!expanded) void fetchExplanation()
    setExpanded(prev => !prev)
  }, [expanded, fetchExplanation])

  const cp = cpLoss(verdict)
  const showCp = cp >= 2 && verdict.verdict !== 'forced' && verdict.verdict !== 'book'
  // score_before is already white's perspective from the backend
  const scoreStr = fmtScore(verdict.score_before)
  const scoreColor = verdict.score_before >= 0 ? '#86efac' : '#fca5a5'

  return (
    <div
      ref={rowRef}
      className={`border-b border-gray-800 last:border-0 ${isActive ? 'bg-amber-700/30' : ''}`}
    >
      <div className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-gray-800/60 transition-colors">
        <button
          onClick={handleRowClick}
          className="flex-1 flex items-center gap-1.5 min-w-0 text-left cursor-pointer"
          title="Aller à cette position"
        >
          {/* Move number (white moves only) */}
          <span className="text-xs text-gray-600 w-4 tabular-nums flex-shrink-0 text-right">
            {verdict.side === 'white' ? `${Math.ceil(verdict.move_number / 2)}.` : ''}
          </span>

          {/* Side indicator */}
          <span className="text-xs w-4 text-center flex-shrink-0"
            style={{ color: verdict.side === 'white' ? '#e5e7eb' : '#6b7280' }}>
            {verdict.side === 'white' ? '⬜' : '⬛'}
          </span>

          {/* Move notation */}
          <span className={`font-mono text-xs flex-1 min-w-0 ${isActive ? 'text-white font-bold' : 'text-white'}`}>
            {verdict.move_notation}
          </span>

          {/* Scan score (white perspective) — cross-check column */}
          <span className="text-xs font-mono tabular-nums flex-shrink-0 w-12 text-right" style={{ color: scoreColor }}>
            {scoreStr}
          </span>

          {/* Verdict badge */}
          <VerdictBadge verdict={verdict.verdict} />

          {/* CP loss — mirrors scan_advisor ACPL metric */}
          {showCp ? (
            <span className="text-xs tabular-nums w-10 text-right flex-shrink-0"
              style={{ color: VERDICT_COLOR[verdict.verdict] }}>
              -{cp}cp
            </span>
          ) : (
            <span className="w-10 flex-shrink-0" />
          )}

          {/* Motif indicator */}
          {verdict.motifs.length > 0 && (
            <span className="text-xs text-indigo-400 flex-shrink-0"
              title={verdict.motifs.map(m => m.motif).join(', ')}>
              ◆{verdict.motifs.length}
            </span>
          )}
        </button>

        <button
          onClick={handleToggleExpand}
          className="text-gray-600 hover:text-gray-300 text-xs flex-shrink-0 w-4 text-center cursor-pointer"
          title={expanded ? 'Replier' : 'Déplier'}
        >
          {expanded ? '▲' : '▼'}
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-2 pt-0.5 bg-gray-900/60 text-xs text-gray-300 leading-relaxed">
          {/* Scan raw data */}
          <div className="flex gap-3 mb-1.5 text-gray-500 font-mono">
            <span>avant : <span className="text-gray-300">{fmtScore(verdict.score_before)}</span></span>
            <span>après : <span className="text-gray-300">{fmtScore(verdict.score_after)}</span></span>
            <span>Δwc : <span style={{ color: VERDICT_COLOR[verdict.verdict] }}>
              {verdict.delta_winchance >= 0 ? '-' : '+'}{Math.abs(Math.round(verdict.delta_winchance * 100))}%
            </span></span>
          </div>

          {/* Explanation */}
          {loadingExpl ? (
            <span className="text-gray-500 animate-pulse">Chargement…</span>
          ) : explanation?.kind === 'ok' ? (
            <p>{explanation.text}</p>
          ) : explanation?.kind === 'not-analyzed' ? (
            <p className="text-amber-400 italic">
              Lance d'abord l'analyse pédagogique de la partie pour voir l'explication.
            </p>
          ) : explanation?.kind === 'error' ? (
            <p className="text-red-400 italic">
              Erreur de chargement de l'explication. Réessaie dans un instant.
            </p>
          ) : (
            <p className="text-gray-500 italic">Pas d'explication disponible.</p>
          )}

          {/* Motifs — clickable to open motif drill */}
          {verdict.motifs.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {verdict.motifs.map((m, i) => (
                <button
                  key={i}
                  onClick={e => { e.stopPropagation(); onMotifClick?.(m.motif) }}
                  className="px-1.5 py-0.5 rounded text-xs transition-opacity hover:opacity-80"
                  style={{
                    background: m.role === 'missed' ? 'rgba(239,68,68,0.15)' : 'rgba(99,102,241,0.15)',
                    color: m.role === 'missed' ? '#fca5a5' : '#a5b4fc',
                    cursor: onMotifClick ? 'pointer' : 'default',
                  }}
                  title={onMotifClick ? 'Travailler ce motif →' : undefined}
                >
                  {m.role === 'missed' ? '↗ ' : ''}{m.motif.replace(/_/g, ' ')}
                  {onMotifClick && ' →'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Accuracy / ACPL summary (per-side) ────────────────────────────────────
// Two rows — user side and opponent side — each with an AccuracyBar,
// the ACPL value, and counts of mistakes / blunders. Extracted from
// PedagogyPanel's monolithic render so the tab system in
// ImportGamePanel can compose it directly.

export function AccuracySummary({
  verdicts, userSide,
}: {
  verdicts: VerdictOut[]
  userSide: 'white' | 'black'
}) {
  const opponentSide: 'white' | 'black' = userSide === 'white' ? 'black' : 'white'
  const rows = [
    { side: userSide,     label: userSide === 'white' ? '⬜' : '⬛',
      vs: verdicts.filter(v => v.side === userSide) },
    { side: opponentSide, label: opponentSide === 'white' ? '⬜' : '⬛',
      vs: verdicts.filter(v => v.side === opponentSide) },
  ] as const
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(({ side, label, vs }) => {
        const bl  = vs.filter(v => v.verdict === 'blunder').length
        const mk  = vs.filter(v => v.verdict === 'mistake').length
        const acc = vs.length
          ? 1 - vs.reduce((s, v) => s + Math.max(v.delta_winchance, 0), 0) / vs.length
          : 1
        const a = acpl(vs)
        return (
          <div key={side} className="flex items-center gap-1.5">
            <span className="text-xs w-4 flex-shrink-0">{label}</span>
            <AccuracyBar accuracy={acc} />
            <span className="text-xs tabular-nums font-mono text-gray-400 w-12 text-right flex-shrink-0"
              title="Perte moyenne en centipions (même calcul que l'annotation Scan)">
              {a}cp
            </span>
            {bl > 0 && <span className="text-xs font-bold flex-shrink-0" style={{ color: '#ef4444' }}>{bl}??</span>}
            {mk > 0 && <span className="text-xs font-bold flex-shrink-0" style={{ color: '#f97316' }}>{mk}?</span>}
          </div>
        )
      })}
    </div>
  )
}

// ── Moves table ───────────────────────────────────────────────────────────
// Filter toggle (all / errors only) + column headers + scrollable move
// list. The container caps its height so it can sit inside a flex layout
// without pushing siblings off-screen. Used by both PedagogyPanel
// (legacy full panel) and ImportGamePanel's Tables tab.

export function MovesTable({
  verdicts, gameId, lang, currentHalfMove, onJumpTo, onMotifClick, maxHeight = 320,
}: {
  verdicts: VerdictOut[]
  gameId: string
  lang: string
  currentHalfMove?: number
  onJumpTo?: (hm: number) => void
  onMotifClick?: (slug: string) => void
  maxHeight?: number
}) {
  const [filter, setFilter] = useState<'all' | 'errors'>('all')
  const shown = filter === 'errors'
    ? verdicts.filter(v => ['inaccuracy', 'mistake', 'blunder'].includes(v.verdict))
    : verdicts
  return (
    <div className="flex flex-col bg-gray-800/40 border border-gray-700 rounded-lg overflow-hidden">
      <div className="flex border-b border-gray-700">
        {(['all', 'errors'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`flex-1 py-1 text-xs font-medium transition-colors ${
              filter === f ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}>
            {f === 'all' ? 'Tous les coups' : 'Erreurs uniquement'}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 text-xs text-gray-600 border-b border-gray-800 px-2 py-1">
        <span className="w-4" />
        <span className="w-4" />
        <span className="flex-1">coup</span>
        <span className="w-12 text-right">éval.</span>
        <span className="w-6 text-center">verdict</span>
        <span className="w-10 text-right">Δcp</span>
        <span className="w-4" />
        <span className="w-3" />
      </div>
      <div className="overflow-y-auto" style={{ maxHeight }}>
        {shown.length === 0 ? (
          <p className="text-xs text-center text-gray-500 py-4">Aucune erreur détectée 🎉</p>
        ) : (
          shown.map(v => (
            <MoveRow
              key={v.move_number}
              verdict={v}
              gameId={gameId}
              lang={lang}
              onMotifClick={onMotifClick}
              isActive={currentHalfMove === v.move_number}
              onJump={onJumpTo}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function PedagogyPanel({ gameId, analysis, loading, userSide, lang, onAnalyze, error, onMotifClick, currentHalfMove, onJumpTo }: Props) {
  if (!analysis && !loading) {
    return (
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold text-gray-300">Analyse pédagogique</span>
          <span className="text-xs text-gray-500 whitespace-nowrap">dilf · cross-check Scan</span>
        </div>
        {error ? (
          <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded p-2 font-mono break-all">
            {error}
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            Verdicts dilf + score Scan brut par coup, pour valider la cohérence du framework.
          </p>
        )}
        <button
          onClick={onAnalyze}
          className="w-full py-1.5 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium transition-colors"
        >
          {error ? '↺ Réessayer' : '🎓 Analyser la partie'}
        </button>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-3 flex items-center gap-2">
        <div className="w-3 h-3 rounded-full bg-indigo-400 animate-pulse flex-shrink-0" />
        <span className="text-xs text-indigo-300">Analyse en cours… (~20s)</span>
      </div>
    )
  }

  const { verdicts } = analysis!

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl flex flex-col">

      {/* Summary header */}
      <div className="px-3 py-2 border-b border-gray-700 flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold text-gray-300">Analyse pédagogique</span>
          <span className="text-xs text-gray-500 whitespace-nowrap">{verdicts.length} demi-coups · Scan</span>
        </div>

        <MaterialTimeline verdicts={verdicts} currentHalfMove={currentHalfMove} onJumpTo={onJumpTo} />
        <GameHeatmap verdicts={verdicts} userSide={userSide} />
        <WeaknessGantt verdicts={verdicts} userSide={userSide} />

        <AccuracySummary verdicts={verdicts} userSide={userSide} />
      </div>

      <MovesTable
        verdicts={verdicts}
        gameId={gameId}
        lang={lang}
        currentHalfMove={currentHalfMove}
        onJumpTo={onJumpTo}
        onMotifClick={onMotifClick}
        maxHeight={288}
      />
    </div>
  )
}
