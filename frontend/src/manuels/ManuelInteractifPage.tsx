import React, { useState } from 'react'
import ManuelInteractif, { type ManuelData } from './ManuelInteractif'
import { MANUELS, type ManuelEntry } from './index'

// Library + reader for the interactive theoretical manuals. The list lazy-loads
// each manual's (large) data module only when opened, so the main bundle stays
// light. Each manual reuses the shared ManuelInteractif viewer.

export default function ManuelInteractifPage({ onClose }: { onClose?: () => void }): React.ReactElement {
  const [open, setOpen] = useState<{ entry: ManuelEntry; data: ManuelData } | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function openManuel(entry: ManuelEntry): Promise<void> {
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

  if (open) {
    return <ManuelInteractif data={open.data} onClose={() => setOpen(null)} />
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
            Manuels théoriques
          </h1>
        </div>
        <p style={{ color: '#9b9485', fontSize: 14, margin: '4px 0 22px' }}>
          Les cours et recueils des maîtres, en lecture interactive : prose d'origine,
          diagrammes jouables et combinaisons à résoudre.
        </p>

        {error && <div style={{ color: '#c07b5e', marginBottom: 16 }}>{error}</div>}

        <div style={{ display: 'grid', gap: 12 }}>
          {MANUELS.map(entry => (
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
    </div>
  )
}
