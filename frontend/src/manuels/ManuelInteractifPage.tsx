import React, { useState, useEffect } from 'react'
import ManuelInteractif, { type ManuelData } from './ManuelInteractif'
import { MANUELS, type ManuelEntry } from './index'
import { PARCOURS_MANUELS } from './parcours'

// Library + reader for the interactive theoretical manuals. The list lazy-loads
// each manual's (large) data module only when opened, so the main bundle stays
// light. Each manual reuses the shared ManuelInteractif viewer.
//
// Pass `source` (e.g. "SIJBRANDS") to open straight into a theoretical manual,
// or `parcoursId` (a curriculum module id) to open a learning-path module as a
// reader — both skip the library. Without either, the library list is shown.

// A loadable reader entry (theoretical manual or parcours module share a shape).
type ReaderEntry = ManuelEntry

// The library lists two families of interactive readers: the original Dubois
// lesson books (prose + playable diagrams, "façon jsx") and the masters' theory
// books. The synthesised "Manuel Débutant" is intentionally excluded — only
// original books are shown.
const _LESSON_BOOK_IDS = ['manuel_dubois_combinaisons', 'manuel_dubois_sens_du_jeu']
// Standalone reader extracted straight from the PDF (not a curriculum module).
const _PERF_COMBI: ReaderEntry = {
  id: 'perfectionnement_combinaisons',
  book: 'Dubois — Perfectionnement : les combinaisons',
  level: 'Avancé',
  load: () => import('./data/perfectionnement_combinaisons'),
}
const _FINS_DE_PARTIE: ReaderEntry = {
  id: 'fins_de_partie',
  book: 'Dubois — Apprendre les fins de partie',
  level: 'Finales',
  load: () => import('./data/fins_de_partie'),
}
// Prose theory books (systems + positional perfectionnement), extracted PDF→reader.
const _SYSTEMES: ReaderEntry[] = [
  { id: 'referentiel_systemes', book: 'Dubois — Référentiel des systèmes de jeu', level: 'Systèmes', load: () => import('./data/referentiel_systemes') },
  { id: 'perf_sens_du_jeu_t1', book: 'Dubois — Perfectionnement : le sens du jeu (t.1)', level: 'Perfectionnement', load: () => import('./data/perf_sens_du_jeu_t1') },
  { id: 'perf_sens_du_jeu_t2', book: 'Dubois — Perfectionnement : le sens du jeu (t.2)', level: 'Perfectionnement', load: () => import('./data/perf_sens_du_jeu_t2') },
  { id: 'perf_sens_du_jeu_t3', book: 'Dubois — Perfectionnement : le sens du jeu (t.3)', level: 'Perfectionnement', load: () => import('./data/perf_sens_du_jeu_t3') },
  { id: 'enchainements', book: 'Grégoire — Les enchaînements', level: 'Stratégie', load: () => import('./data/enchainements') },
  { id: 'couttet_ouvertures', book: 'Couttet — Étude des ouvertures', level: 'Ouvertures', load: () => import('./data/couttet_ouvertures') },
]
const LIBRARY_SECTIONS: { title: string; entries: ReaderEntry[] }[] = [
  {
    title: 'Cours & exercices',
    entries: [
      ..._LESSON_BOOK_IDS.map(id => PARCOURS_MANUELS[id]).filter(Boolean),
      _PERF_COMBI, _FINS_DE_PARTIE,
    ],
  },
  { title: 'Systèmes & perfectionnement', entries: _SYSTEMES },
  { title: 'Livres théoriques', entries: MANUELS },
]

interface Props {
  onClose?: () => void
  /** Corpus source code to open directly (case-insensitive), e.g. "SIJBRANDS". */
  source?: string
  /** Curriculum module id (or standalone book id) to open directly. */
  parcoursId?: string
  /** Chapter number to open at (e.g. from the Exercices 📖 lesson button). */
  initialChapter?: number
}

export default function ManuelInteractifPage({ onClose, source, parcoursId, initialChapter }: Props): React.ReactElement {
  const [open, setOpen] = useState<{ entry: ReaderEntry; data: ManuelData } | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function openManuel(entry: ReaderEntry): Promise<void> {
    setLoading(entry.id); setError(null)
    try {
      const mod = await entry.load()
      setOpen({ entry, data: mod.default })
    } catch {
      setError(`Impossible de charger « ${entry.book} ».`)
    } finally {
      setLoading(null)
    }
  }

  // Direct-open mode: a specific reader was requested (manual link, curriculum
  // module, or any library entry id — e.g. a reading recommendation's reader).
  const directId = parcoursId ?? (source ? source.toLowerCase() : null)
  const libraryEntry = directId
    ? LIBRARY_SECTIONS.flatMap(s => s.entries).find(e => e.id === directId)
    : undefined
  const directEntry: ReaderEntry | undefined = parcoursId
    ? (PARCOURS_MANUELS[parcoursId] ?? libraryEntry)
    : (directId ? (MANUELS.find(m => m.id === directId) ?? libraryEntry) : undefined)
  useEffect(() => {
    if (directEntry && (!open || open.entry.id !== directEntry.id)) {
      void openManuel(directEntry)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directId])

  if (open) {
    // In direct-open mode, closing the reader returns to the caller (onClose);
    // from the library it returns to the list.
    return <ManuelInteractif data={open.data} initialChapter={initialChapter} onClose={directEntry ? onClose : () => setOpen(null)} />
  }

  if (directEntry) {
    // Loading the requested manual — render nothing heavy meanwhile.
    return (
      <div style={{ width: '100%', height: '100%', background: '#161419', color: '#9b9485',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {error || `Chargement de « ${directEntry.book} »…`}
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100%', overflowY: 'auto', background: '#161419', color: '#ece3d2' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '18px 18px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                background: '#262430', color: '#ece3d2', border: '1px solid #322f3c',
                borderRadius: 8, padding: '7px 11px', fontSize: 13, cursor: 'pointer',
              }}
            >←</button>
          )}
          <h1 style={{ fontFamily: 'Georgia, serif', fontWeight: 500, fontSize: 28, margin: 0 }}>
            Bibliothèque
          </h1>
        </div>
        <p style={{ color: '#9b9485', fontSize: 14, margin: '4px 0 22px' }}>
          Cours et recueils des maîtres en lecture interactive : prose d'origine,
          diagrammes jouables et combinaisons à résoudre.
        </p>

        {error && <div style={{ color: '#c07b5e', marginBottom: 16 }}>{error}</div>}

        {LIBRARY_SECTIONS.map(section => (
          <div key={section.title} style={{ marginBottom: 26 }}>
            <h2 style={{ fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase',
              color: '#c9a24a', margin: '0 0 10px' }}>{section.title}</h2>
            <div style={{ display: 'grid', gap: 12 }}>
              {section.entries.map(entry => (
                <button
                  key={entry.id}
                  onClick={() => openManuel(entry)}
                  disabled={loading != null}
                  style={{
                    textAlign: 'left', background: '#1f1d25', border: '1px solid #322f3c',
                    borderRadius: 14, padding: '16px 18px', cursor: 'pointer', color: '#ece3d2',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                    opacity: loading && loading !== entry.id ? 0.5 : 1,
                  }}
                >
                  <span>
                    <span style={{ fontFamily: 'Georgia, serif', fontSize: 18, display: 'block' }}>
                      {entry.book}
                    </span>
                    <span style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: '#c9a24a' }}>
                      {entry.level}
                    </span>
                  </span>
                  <span style={{ color: '#9b9485', fontSize: 20 }}>
                    {loading === entry.id ? '…' : '→'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
