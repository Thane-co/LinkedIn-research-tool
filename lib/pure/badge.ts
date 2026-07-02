// Layer 0 — x-factor badge presentation logic (PRD §12 step 27). Zero I/O.
// Thresholds: ≥2× viral (green 🔥) · 0.5×–2× normal (gray) · <0.5× underperforming (red).
// A null x_factor (no baseline yet) has no badge.

export type BadgeTone = 'green' | 'gray' | 'red' | 'none'

export interface XFactorBadge {
  tone: BadgeTone
  emoji: string
  label: string | null
}

export function xFactorBadge(xFactor: number | null): XFactorBadge {
  if (xFactor === null) return { tone: 'none', emoji: '', label: null }
  const label = `${xFactor.toFixed(1)}×`
  if (xFactor >= 2) return { tone: 'green', emoji: '🔥', label }
  if (xFactor >= 0.5) return { tone: 'gray', emoji: '', label }
  return { tone: 'red', emoji: '', label }
}
