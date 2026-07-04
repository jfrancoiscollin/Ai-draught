import React, { useEffect, useState } from 'react'
import { useLanguage } from '../i18n/LanguageContext'
import { useAuth } from '../contexts/AuthContext'
import { getLessonTitles, getExercises, getReadLessons, getUserProgress } from '../api/client'

interface Book {
  id: string
  title: string
  titleEn: string
  author: string
  category: 'manuel'
  emoji: string
  hasExercises: boolean
}

// Manuels pédagogiques préprocessés par Claude via dilf (un par niveau).
// Voir `dilf/docs/MANUELS_PIPELINE.md` et `backend/manuels/`.
const BOOKS: Book[] = [
  {
    id: 'manuel_dubois_combinaisons',
    title: 'Apprentissage des combinaisons',
    titleEn: 'Learning combinations',
    author: 'Jean-Pierre Dubois',
    category: 'manuel',
    emoji: '🌱',
    hasExercises: true,
  },
  {
    id: 'manuel_goedemoed',
    title: 'Goedemoed — A Course in Draughts',
    titleEn: 'Goedemoed — A Course in Draughts',
    author: 'Tjalling Goedemoed',
    category: 'manuel',
    emoji: '📘',
    hasExercises: true,
  },
  {
    id: 'manuel_goedemoed3',
    title: 'Goedemoed — Exercices (vol. 3)',
    titleEn: 'Goedemoed — Exercises (vol. 3)',
    author: 'Tjalling Goedemoed',
    category: 'manuel',
    emoji: '📗',
    hasExercises: true,
  },
  {
    id: 'manuel_perf_combinaisons',
    title: 'Perfectionnement — Les combinaisons',
    titleEn: 'Advanced combinations',
    author: 'Jean-Pierre Dubois',
    category: 'manuel',
    emoji: '🧩',
    hasExercises: true,
  },
  {
    id: 'manuel_fins_de_partie',
    title: 'Apprendre les fins de partie',
    titleEn: 'Learning endgames',
    author: 'Jean-Pierre Dubois',
    category: 'manuel',
    emoji: '👑',
    hasExercises: true,
  },
]

const CATEGORY_LABELS: Record<string, Record<'fr' | 'en', string>> = {
  manuel: { fr: 'Manuels pédagogiques', en: 'Pedagogical manuals' },
}

interface BookStats {
  totalLessons: number
  totalExercises: number
  readLessons: number
  solvedExercises: number
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.min(100, value)}%` }}
      />
    </div>
  )
}

interface ExerciseLibraryPageProps {
  onSelectBook: (bookId: string) => void
  /** Back to the learning path — the library is now a sub-view of the
   *  Parcours (the single educational entry point). */
  onBack?: () => void
}

export default function ExerciseLibraryPage({ onSelectBook, onBack }: ExerciseLibraryPageProps) {
  const { t, language } = useLanguage()
  const { user } = useAuth()
  const [stats, setStats] = useState<Record<string, BookStats>>({})

  const enabledBooks = BOOKS.filter(b => b.hasExercises)

  useEffect(() => {
    // Fetch totals for each enabled book
    Promise.all(
      enabledBooks.map(book =>
        Promise.all([
          getLessonTitles(book.id),
          getExercises({ book_id: book.id }),
        ]).then(([lessons, exercises]) => ({
          bookId: book.id,
          totalLessons: Object.keys(lessons).length,
          totalExercises: exercises.length,
          exerciseIds: exercises.map(e => e.id),
        }))
      )
    ).then(results => {
      setStats(prev => {
        const next = { ...prev }
        for (const r of results) {
          next[r.bookId] = {
            totalLessons: r.totalLessons,
            totalExercises: r.totalExercises,
            readLessons: prev[r.bookId]?.readLessons ?? 0,
            solvedExercises: prev[r.bookId]?.solvedExercises ?? 0,
          }
        }
        return next
      })
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) {
      setStats(prev => {
        const next = { ...prev }
        for (const book of enabledBooks) {
          if (next[book.id]) {
            next[book.id] = { ...next[book.id], readLessons: 0, solvedExercises: 0 }
          }
        }
        return next
      })
      return
    }
    // Fetch user progress alongside per-book exercise lists to count solved per book
    Promise.all([
      getReadLessons(),
      getUserProgress(),
      ...enabledBooks.map(book => getExercises({ book_id: book.id })),
    ]).then(([readChapters, solvedIds, ...bookExerciseLists]) => {
      const solvedSet = new Set(solvedIds as number[])
      setStats(prev => {
        const next = { ...prev }
        enabledBooks.forEach((book, i) => {
          const bookExIds = (bookExerciseLists[i] as { id: number }[]).map(e => e.id)
          // Count how many of this book's chapter numbers appear in readChapters
          const bookChapters = (bookExerciseLists[i] as { chapter?: number }[])
            .map(e => e.chapter)
            .filter((c): c is number => c != null)
          const uniqueChapters = new Set(bookChapters)
          const readCount = (readChapters as number[]).filter(ch => uniqueChapters.has(ch)).length
          next[book.id] = {
            totalLessons: prev[book.id]?.totalLessons ?? 0,
            totalExercises: prev[book.id]?.totalExercises ?? 0,
            readLessons: readCount,
            solvedExercises: bookExIds.filter(id => solvedSet.has(id)).length,
          }
        })
        return next
      })
    }).catch(() => {})
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const categories: Book['category'][] = ['manuel']

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-8">
        {onBack && (
          <button
            onClick={onBack}
            className="text-amber-400 hover:text-amber-300 mb-4 flex items-center gap-1"
          >
            ← {language === 'fr' ? 'Retour au parcours' : 'Back to the path'}
          </button>
        )}
        <h2 className="text-xl font-bold text-amber-500 mb-1">{t('tabExercises')}</h2>
        <p className="text-gray-400 text-sm mb-8">{t('chooseBook')}</p>

        {categories.map(cat => {
          const books = BOOKS.filter(b => b.category === cat)
          return (
            <div key={cat} className="mb-8">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3 border-b border-gray-700 pb-1">
                {CATEGORY_LABELS[cat][language]}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {books.map(book => {
                  const s = stats[book.id]
                  const exercisePct = s && s.totalExercises > 0 ? Math.round((s.solvedExercises / s.totalExercises) * 100) : 0

                  return (
                    <button
                      key={book.id}
                      onClick={() => book.hasExercises && onSelectBook(book.id)}
                      disabled={!book.hasExercises}
                      className={`group relative flex flex-col items-start gap-2 rounded-xl border p-5 text-left transition-all duration-200 ${
                        book.hasExercises
                          ? 'bg-gray-800 border-gray-700 hover:border-amber-600 hover:bg-gray-750 cursor-pointer'
                          : 'bg-gray-850 border-gray-800 opacity-60 cursor-not-allowed'
                      }`}
                    >
                      {!book.hasExercises && (
                        <span className="absolute top-3 right-3 text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded-full">
                          {t('comingSoon')}
                        </span>
                      )}
                      <span className="text-3xl">{book.emoji}</span>
                      <div className="min-w-0 w-full">
                        <p className={`font-semibold text-sm leading-snug ${book.hasExercises ? 'text-white group-hover:text-amber-400' : 'text-gray-400'}`}>
                          {language === 'en' ? book.titleEn : book.title}
                        </p>
                        {book.author && (
                          <p className="text-xs text-gray-500 mt-0.5">{book.author}</p>
                        )}
                      </div>

                      {book.hasExercises && s && (
                        <div className="w-full flex flex-col gap-1.5 mt-1">
                          <div className="flex flex-col gap-0.5">
                            <div className="flex justify-between text-xs">
                              <span className="text-gray-400">✓ Exercices</span>
                              <span className={exercisePct === 100 ? 'text-amber-400 font-semibold' : 'text-gray-400'}>
                                {user ? `${s.solvedExercises}/${s.totalExercises}` : `${s.totalExercises}`}
                              </span>
                            </div>
                            {user && <ProgressBar value={exercisePct} color="bg-amber-500" />}
                          </div>
                        </div>
                      )}

                      {book.hasExercises && !s && (
                        <span className="text-xs text-green-400 font-medium">{t('exercisesAvailable')}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}

        {/* ── Motifs détectables par l'analyse pédagogique ────────── */}
        <MotifCatalogSection language={language} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Catalogue des motifs reconnus par dilf, groupés par famille. Affichés en
// bas de la page Apprendre via des <details> repliables.
// ---------------------------------------------------------------------------

interface MotifEntry {
  slug: string
  fr: string
  en: string
  desc_fr: string
}

const MOTIF_FAMILIES: Array<{
  id: string
  fr: string
  en: string
  motifs: MotifEntry[]
}> = [
  {
    id: 'coups_nommes',
    fr: 'Coups nommés tactiques',
    en: 'Named tactical coups',
    motifs: [
      { slug: 'coup_royal',     fr: 'Coup royal',     en: 'Royal coup',
        desc_fr: 'Sacrifice → rafle finale qui prend tout.' },
      { slug: 'coup_turc',      fr: 'Coup turc',      en: 'Turkish coup',
        desc_fr: 'La dame traverse une case déjà visitée pendant la rafle.' },
      { slug: 'coup_de_talon',  fr: 'Coup du talon',  en: 'Heel coup',
        desc_fr: 'La rafle change de direction en cours de route.' },
      { slug: 'coup_express',   fr: 'Coup express',   en: 'Express coup',
        desc_fr: 'Rafle longue (4-5 prises) sur une diagonale.' },
      { slug: 'coup_napoleon',  fr: 'Coup Napoléon',  en: 'Napoleon coup',
        desc_fr: 'Sacrifice par enfilade ouvrant une grande diagonale.' },
      { slug: 'coup_bonnard',   fr: 'Coup Bonnard',   en: 'Bonnard coup',
        desc_fr: 'Envoi à dame avec sacrifice préliminaire.' },
      { slug: 'coup_philippe',  fr: 'Coup Philippe',  en: 'Philippe coup',
        desc_fr: 'Motif Philippe.' },
      { slug: 'coup_raphael',   fr: 'Coup Raphaël',   en: 'Raphaël coup',
        desc_fr: 'Motif Raphaël.' },
      { slug: 'coup_manoury',   fr: 'Coup Manoury',   en: 'Manoury coup',
        desc_fr: 'Motif Manoury.' },
      { slug: 'coup_enfilade',  fr: 'Coup d’enfilade', en: 'Enfilade coup',
        desc_fr: 'Alignement diagonal exploité par rafle.' },
      { slug: 'coup_du_bruleur', fr: 'Coup du brûleur', en: 'Burner coup',
        desc_fr: 'Sacrifice qui « brûle » la dame adverse.' },
      { slug: 'envoi_a_dame',   fr: 'Envoi à dame',   en: 'Promotion sacrifice',
        desc_fr: 'Sacrifice + promotion + rafle de dame.' },
    ],
  },
  {
    id: 'erreurs',
    fr: 'Erreurs tactiques',
    en: 'Tactical mistakes',
    motifs: [
      { slug: 'prise_max_ratee', fr: 'Prise maximale ratée', en: 'Missed maximum capture',
        desc_fr: 'Vous avez manqué la prise maximale obligatoire.' },
      { slug: 'sacrifice',       fr: 'Sacrifice',            en: 'Sacrifice',
        desc_fr: 'Sacrifice général (motif catch-all).' },
    ],
  },
  {
    id: 'combinaisons',
    fr: 'Combinaisons génériques',
    en: 'Generic combinations',
    motifs: [
      { slug: 'combinaison_2_temps', fr: 'Combinaison en 2 temps', en: '2-move combination',
        desc_fr: 'Enchaînement forcé de 2 coups attaquants menant à un gain matériel.' },
      { slug: 'combinaison_3_temps', fr: 'Combinaison en 3 temps', en: '3-move combination',
        desc_fr: 'Enchaînement forcé de 3 coups attaquants menant à un gain matériel.' },
      { slug: 'combinaison_4_temps', fr: 'Combinaison en 4 temps', en: '4-move combination',
        desc_fr: 'Enchaînement forcé de 4 coups attaquants menant à un gain matériel.' },
      { slug: 'combinaison_5_temps', fr: 'Combinaison en 5+ temps', en: '5+ move combination',
        desc_fr: 'Enchaînement forcé de 5 coups ou plus menant à un gain matériel.' },
    ],
  },
]

function MotifCatalogSection({ language }: { language: 'fr' | 'en' }) {
  return (
    <div className="mt-8 mb-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3 border-b border-gray-700 pb-1">
        {language === 'en' ? 'Detectable motifs (analysis)' : 'Motifs détectables (analyse pédagogique)'}
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        {language === 'en'
          ? 'These motifs are detected by dilf when you analyse a game from your Profil page.'
          : 'Ces motifs sont détectés par dilf lorsque vous analysez une partie depuis votre page Profil.'}
      </p>
      <div className="flex flex-col gap-2">
        {MOTIF_FAMILIES.map(fam => (
          <details
            key={fam.id}
            className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2"
          >
            <summary className="cursor-pointer text-sm font-semibold text-amber-500 select-none flex items-center justify-between">
              <span>{language === 'en' ? fam.en : fam.fr}</span>
              <span className="text-xs text-gray-500 font-normal">×{fam.motifs.length}</span>
            </summary>
            <ul className="mt-2 space-y-1.5">
              {fam.motifs.map(m => (
                <li key={m.slug} className="flex flex-col gap-0.5">
                  <span className="text-sm text-gray-200">{language === 'en' ? m.en : m.fr}</span>
                  {language === 'fr' && (
                    <span className="text-xs text-gray-500">{m.desc_fr}</span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  )
}
