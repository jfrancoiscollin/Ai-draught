import React, { useCallback, useEffect, useState } from 'react'
import Board from './Board'
import { fenToBoard } from '../utils/fen'
import { useLanguage } from '../i18n/LanguageContext'
import { useAuth } from '../contexts/AuthContext'
import {
  getCurriculum,
  getCurriculumModule,
  getCurriculumProgress,
} from '../api/client'
import type {
  CurriculumTree,
  CurriculumModule,
  CurriculumModuleSummary,
  ModuleState,
} from '../types'

interface Props {
  onClose: () => void
  // Deep-link an exercise into the existing solver (book + exercise id).
  onOpenExercise: (exerciseId: number) => void
  // Open a manual chapter's lesson prose (reuses the rich LessonPanel overlay).
  onOpenLesson: (chapter: number) => void
  // Open a strategic manual's long-form reading view for a source (e.g. KELLER).
  onOpenManual: (source: string) => void
  // Open the exercise/manual library (free browsing) — a sub-view of the path.
  onOpenLibrary: () => void
  // Open a whole module as the interactive reader (lessons = chapters).
  onOpenModuleReader: (moduleId: string) => void
}

const STATE_STYLE: Record<ModuleState, { ring: string; badge: string; label: string; labelEn: string }> = {
  done: { ring: 'border-green-600 bg-green-900/20', badge: 'bg-green-700 text-green-100', label: 'Terminé', labelEn: 'Done' },
  in_progress: { ring: 'border-amber-600 bg-amber-900/15', badge: 'bg-amber-700 text-amber-100', label: 'En cours', labelEn: 'In progress' },
  available: { ring: 'border-gray-600 bg-gray-800 hover:border-amber-600', badge: 'bg-gray-600 text-gray-200', label: 'À commencer', labelEn: 'Start' },
  locked: { ring: 'border-gray-800 bg-gray-850 opacity-60', badge: 'bg-gray-700 text-gray-400', label: 'Verrouillé', labelEn: 'Locked' },
}

const ProgressBar: React.FC<{ value: number; total: number; state: ModuleState }> = ({ value, total, state }) => {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  const color = state === 'done' ? 'bg-green-500' : 'bg-amber-500'
  return (
    <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden mt-2">
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

const LearningPathPage: React.FC<Props> = ({ onClose, onOpenExercise, onOpenLesson, onOpenManual, onOpenLibrary, onOpenModuleReader }) => {
  const { language } = useLanguage()
  const { user } = useAuth()
  const isLoggedIn = !!user
  const fr = language === 'fr'

  const [tree, setTree] = useState<CurriculumTree | null>(null)
  const [stateById, setStateById] = useState<Record<string, { state: ModuleState; n_solved: number; n_total: number }>>({})
  const [nextModule, setNextModule] = useState<string | null>(null)
  const [openModule, setOpenModule] = useState<CurriculumModule | null>(null)
  const [loading, setLoading] = useState(true)

  // Refetch progress: solving exercises elsewhere should reflect here when
  // the user returns to the overview (the overview stays mounted while a
  // module detail is open, so a re-mount alone wouldn't refresh it).
  const refreshProgress = useCallback(async () => {
    if (!isLoggedIn) { setStateById({}); setNextModule(null); return }
    try {
      const prog = await getCurriculumProgress()
      const map: Record<string, { state: ModuleState; n_solved: number; n_total: number }> = {}
      prog.modules.forEach(m => { map[m.id] = { state: m.state, n_solved: m.n_solved, n_total: m.n_total } })
      setStateById(map)
      setNextModule(prog.next_module)
    } catch { /* no progress yet */ }
  }, [isLoggedIn])

  useEffect(() => {
    let alive = true
    setLoading(true)
    getCurriculum()
      .then(async curr => {
        if (!alive) return
        setTree(curr)
        await refreshProgress()
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [refreshProgress])

  const stateFor = (m: CurriculumModuleSummary): ModuleState => {
    if (stateById[m.id]) return stateById[m.id].state
    // Staging unlock (or logged-out on an unlocked instance): everything open.
    if (tree?.unlock_all) return 'available'
    // Logged-out fallback: first-in-order with no prereqs is available.
    return m.prerequisites.length === 0 ? 'available' : 'locked'
  }

  const openModuleDetail = (id: string) => {
    getCurriculumModule(id).then(setOpenModule)
  }

  if (loading) {
    return <div className="p-8 text-gray-400">{fr ? 'Chargement du parcours…' : 'Loading path…'}</div>
  }
  if (!tree) {
    return <div className="p-8 text-gray-400">{fr ? 'Parcours indisponible.' : 'Path unavailable.'}</div>
  }

  // ── Module detail view ──────────────────────────────────────────────
  if (openModule) {
    return (
      <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 sm:p-6">
        <button
          onClick={() => { setOpenModule(null); refreshProgress() }}
          className="text-amber-400 hover:text-amber-300 mb-4 flex items-center gap-1"
        >
          ← {fr ? 'Retour au parcours' : 'Back to path'}
        </button>
        <h2 className="text-2xl font-bold text-amber-500">{openModule.title}</h2>
        {openModule.subtitle && <p className="text-gray-400 mt-1">{openModule.subtitle}</p>}
        {openModule.goal && (
          <div className="mt-3 rounded-lg border border-amber-800 bg-amber-900/15 p-3 text-sm text-amber-100">
            🎯 {openModule.goal}
          </div>
        )}
        <div className="mt-6 space-y-6">
          {openModule.lessons.map((les, i) => {
            const positions = les.items.filter(it => it.kind === 'position')
            const exercises = les.items.filter(it => it.kind === 'exercise')
            const manuals = les.items.filter(it => it.kind === 'manual')
            return (
            <div key={les.id} className="rounded-xl border border-gray-700 bg-gray-800 p-4">
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-gray-500">{fr ? 'Leçon' : 'Lesson'} {i + 1}</span>
                <h3 className="text-lg font-semibold text-gray-100">{les.title}</h3>
              </div>
              {les.intro && <p className="text-gray-400 text-sm mt-1 leading-relaxed">{les.intro}</p>}

              {/* The lesson comes first: read the teaching, then practise. */}
              {les.chapter != null && (
                <button
                  onClick={() => onOpenLesson(les.chapter as number)}
                  className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-700 bg-amber-900/20 px-3 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-800/30 transition-colors"
                >
                  📖 {fr ? 'Lire la leçon' : 'Read the lesson'}
                </button>
              )}

              {/* Strategic manual reading — opens the long-form vectorial
                  manual view for the source (chapters grouped by theme). */}
              {manuals.map(it => (
                <button
                  key={String(it.ref)}
                  onClick={() => onOpenManual(String(it.source ?? it.ref))}
                  className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-700 bg-amber-900/20 px-3 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-800/30 transition-colors"
                >
                  📖 {fr ? 'Lire le manuel' : 'Read the manual'}
                </button>
              ))}

              {/* Illustrative positions — the visual lesson for strategy
                  concepts that have no manual prose. Static diagrams. */}
              {positions.length > 0 && (
                <div className="mt-3">
                  <div className="text-xs text-gray-500 uppercase font-semibold mb-2">
                    📖 {fr ? 'La leçon en images' : 'The lesson in pictures'} · {positions.length} {fr ? 'positions types' : 'example positions'}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {positions.map(it => (
                      <div key={it.ref} className="rounded-md overflow-hidden bg-gray-900 p-1">
                        <Board
                          board={fenToBoard(String(it.fen))}
                          legalMoves={[]}
                          onMove={() => {}}
                          selectedSquare={null}
                          onSelectSquare={() => {}}
                          disabled
                          flipped={String(it.fen).startsWith('B:')}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {exercises.length > 0 && (
                <div className="mt-4 border-t border-gray-700 pt-3">
                  <div className="text-xs text-gray-500 uppercase font-semibold mb-2">
                    {fr ? 'Pratiquez' : 'Practise'} · {exercises.length} {fr ? 'exercices' : 'exercises'}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {exercises.map(it => (
                      <button
                        key={it.ref}
                        onClick={() => onOpenExercise(Number(it.ref))}
                        title={it.name}
                        className="px-2.5 py-1 rounded-md text-xs bg-gray-700 hover:bg-amber-700 text-gray-200 transition-colors"
                      >
                        {'★'.repeat(it.difficulty ?? 1)} #{it.ref}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            )
          })}
        </div>
      </div>
      </div>
    )
  }

  // ── Path overview ───────────────────────────────────────────────────
  return (
    <div className="h-full overflow-y-auto">
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-2xl font-bold text-amber-500">{fr ? 'Parcours d’apprentissage' : 'Learning path'}</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-200">✕</button>
      </div>
      <p className="text-gray-400 mb-6">
        {fr
          ? 'Une progression guidée, du damier aux combinaisons. Terminez un module pour débloquer le suivant.'
          : 'A guided progression, from the board to combinations. Finish a module to unlock the next.'}
      </p>

      {!isLoggedIn && (
        <div className="mb-6 rounded-lg border border-amber-800 bg-amber-900/15 p-3 text-sm text-amber-100">
          {fr
            ? '🔑 Connectez-vous pour enregistrer votre progression : sans connexion, les exercices résolus ne sont pas suivis et les modules suivants ne se débloquent pas.'
            : '🔑 Log in to save your progress: without an account, solved exercises are not tracked and later modules stay locked.'}
        </div>
      )}

      {/* Free-browsing library — the old "Apprendre" entry, now a
          secondary door inside the single educational hub. */}
      <button
        onClick={onOpenLibrary}
        className="group w-full mb-6 flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-800 hover:border-amber-600 hover:bg-gray-750 px-4 py-3 text-left transition-all duration-200 cursor-pointer"
      >
        <span className="text-2xl">📚</span>
        <span className="min-w-0">
          <span className="block font-semibold text-gray-100">
            {fr ? 'Bibliothèque' : 'Library'}
          </span>
          <span className="block text-xs text-gray-400">
            {fr
              ? 'Parcourir librement les manuels et exercices, hors progression guidée.'
              : 'Freely browse manuals and exercises, outside the guided path.'}
          </span>
        </span>
        <span className="ml-auto text-gray-500 group-hover:text-amber-400">→</span>
      </button>

      {tree.levels.map(level => (
        <div key={level.id} className="mb-8">
          <div className="flex items-baseline gap-3 mb-1">
            <h3 className="text-xl font-bold text-gray-100">{level.title}</h3>
          </div>
          {level.subtitle && <p className="text-gray-500 text-sm mb-4">{level.subtitle}</p>}

          <ol className="space-y-3">
            {tree.modules
              .filter(m => m.level === level.id)
              .sort((a, b) => a.order - b.order)
              .map(m => {
                const st = stateFor(m)
                const sty = STATE_STYLE[st]
                const prog = stateById[m.id]
                const isNext = m.id === nextModule
                const clickable = st !== 'locked'
                return (
                  <li key={m.id}>
                    <button
                      disabled={!clickable}
                      onClick={() => clickable && onOpenModuleReader(m.id)}
                      className={`group relative w-full rounded-xl border p-4 text-left transition-all duration-200 ${sty.ring} ${clickable ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-500 text-sm font-mono">{m.order}.</span>
                            <span className="font-semibold text-gray-100">{m.title}</span>
                            {isNext && (
                              <span className="text-[10px] uppercase font-bold bg-amber-600 text-white px-1.5 py-0.5 rounded">
                                {fr ? 'À suivre' : 'Next'}
                              </span>
                            )}
                          </div>
                          {m.subtitle && <p className="text-gray-400 text-sm mt-0.5">{m.subtitle}</p>}
                          {m.goal && <p className="text-gray-500 text-xs mt-1 italic">🎯 {m.goal}</p>}
                        </div>
                        <span className={`shrink-0 text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${sty.badge}`}>
                          {st === 'locked' && '🔒 '}{fr ? sty.label : sty.labelEn}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                        <span>{m.n_lessons} {fr ? 'leçons' : 'lessons'}</span>
                        <span>·</span>
                        {(m.n_manuals ?? 0) > 0 && m.n_exercises === 0 ? (
                          <span>{m.n_manuals} {fr ? 'manuels à lire' : 'manuals to read'}</span>
                        ) : m.n_exercises === 0 ? (
                          <span>{fr ? 'chapitres à lire' : 'chapters to read'}</span>
                        ) : (
                          <span>{m.n_exercises} {fr ? 'exercices' : 'exercises'}</span>
                        )}
                        {prog && prog.n_total > 0 && (
                          <span className="ml-auto">{prog.n_solved}/{prog.n_total}</span>
                        )}
                      </div>
                      {prog && prog.n_total > 0 && <ProgressBar value={prog.n_solved} total={prog.n_total} state={st} />}
                      {st === 'locked' && m.prerequisites.length > 0 && (
                        <p className="text-[11px] text-gray-600 mt-2">
                          {fr ? 'Terminez d’abord : ' : 'Finish first: '}
                          {m.prerequisites.map(p => tree.modules.find(x => x.id === p)?.title ?? p).join(', ')}
                        </p>
                      )}
                    </button>
                    {clickable && (
                      <button
                        onClick={() => openModuleDetail(m.id)}
                        className="mt-1 ml-1 text-xs text-gray-500 hover:text-amber-500"
                      >
                        {fr ? 'Progression & exercices →' : 'Progress & exercises →'}
                      </button>
                    )}
                  </li>
                )
              })}
          </ol>
        </div>
      ))}
    </div>
    </div>
  )
}

export default LearningPathPage
