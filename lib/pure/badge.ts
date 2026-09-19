// Layer 0 — x-factor v2 badge presentation logic (PRD §8). Zero I/O.
//
// The badge reads the robust rarity z (x_score), not the raw ratio:
//   >= RARE_Z    -> green 🔥 (rare)
//   >= NOTABLE_Z -> amber   (notable)
//   <= LOW_Z     -> red     (underperformed)
//   otherwise    -> gray
// A provisional post with no score yet shows a hollow 'new' pill (no number); a post with no score
// and not provisional (no history) shows nothing. The label pairs the sigma with the ratio, and adds
// '(day N)' while the post is still provisional.

import { LOW_Z, NOTABLE_Z, RARE_Z } from '@/lib/config'

export type BadgeTone = 'green' | 'amber' | 'gray' | 'red' | 'pending' | 'none'

export interface XFactorBadge {
  tone: BadgeTone
  emoji: string
  label: string | null
}

/**
 * @param xScore      the robust rarity z, or null when the post has no score
 * @param xFactor     the ratio to the creator's median level, or null
 * @param provisional 1 while the post is inside the 3-day maturity window
 * @param ageDays     integer age (days) at last measurement — shown as "(day N)" when provisional
 */
export function xFactorBadge(
  xScore: number | null,
  xFactor: number | null,
  provisional: 0 | 1,
  ageDays?: number | null,
): XFactorBadge {
  // No score yet. Provisional -> a hollow "new" pill (rescored daily); otherwise nothing to show.
  if (xScore === null) {
    if (provisional === 1) return { tone: 'pending', emoji: '', label: 'new' }
    return { tone: 'none', emoji: '', label: null }
  }

  const sigma = `${xScore.toFixed(1)}σ`
  const ratio = xFactor !== null ? ` · ${xFactor.toFixed(1)}×` : ''
  const dayTag = provisional === 1 && ageDays != null ? ` (day ${ageDays})` : ''
  const label = `${sigma}${ratio}${dayTag}`

  if (xScore >= RARE_Z) return { tone: 'green', emoji: '🔥', label }
  if (xScore >= NOTABLE_Z) return { tone: 'amber', emoji: '', label }
  if (xScore <= LOW_Z) return { tone: 'red', emoji: '', label }
  return { tone: 'gray', emoji: '', label }
}
