import type { Color } from 'claude-code'

import type { Pr } from '../types'

/** One detail line of a PR in the pane: its words and, when it signals something, a color. */
export type Line = { text: string; color?: Color }

/** `a, b, c +2`: at most three names, then how many more. */
const names = (list: readonly string[]): string =>
  list.length > 3 ? `${list.slice(0, 3).join(', ')} +${list.length - 3}` : list.join(', ')

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** `✗ 2 failed (checks, test) · 10 passed`: the head commit's checks by outcome. */
export const ciLine = (p: Pr): Line => {
  const { passed, pending, skipped } = p.checks
  // The named failures count even where GitHub's tally of them is missing.
  const failed = Math.max(p.checks.failed, p.failedChecks.length)
  if (passed + failed + pending + skipped === 0) return { text: 'no checks', color: 'subtle' }

  const failedNames = p.failedChecks.length > 0 ? ` (${names(p.failedChecks)})` : ''
  const parts = [
    ...(failed > 0 ? [`${failed} failed${failedNames}`] : []),
    ...(pending > 0 ? [`${pending} running`] : []),
    ...(passed > 0 ? [`${passed} passed`] : []),
    ...(skipped > 0 ? [`${skipped} skipped`] : []),
  ].join(' · ')

  if (failed > 0) return { text: `✗ ${parts}`, color: 'error' }
  if (pending > 0) return { text: `● ${parts}`, color: 'warning' }

  return { text: `✓ ${parts}`, color: 'success' }
}

/** `✓ approved by a · waiting on you · 2 unresolved threads`. */
export const reviewLine = (p: Pr): Line => {
  const { approvedBy, changesBy, waitingOn, unresolvedThreads } = p.reviews
  const parts = [
    ...(approvedBy.length > 0 ? [`✓ approved by ${names(approvedBy)}`] : []),
    ...(changesBy.length > 0 ? [`✎ changes requested by ${names(changesBy)}`] : []),
    ...(waitingOn.length > 0 ? [`waiting on ${names(waitingOn)}`] : []),
  ]
  if (parts.length === 0) parts.push(p.review === 'required' ? 'review required' : 'no reviews yet')
  if (unresolvedThreads > 0) parts.push(`${plural(unresolvedThreads, 'unresolved thread')}`)

  const text = parts.join(' · ')
  if (changesBy.length > 0) return { text, color: 'error' }
  if (waitingOn.includes('you')) return { text, color: 'warning' }
  if (p.review === 'approved') return { text, color: 'success' }

  return { text }
}

/** Whether GitHub would let it merge now, and if not, why. */
export const mergeLine = (p: Pr): Line => {
  const base = p.baseBranch || 'the base branch'
  if (p.merge === 'conflict' || p.mergeStatus === 'conflict') {
    return { text: `⚠ conflicts with ${base}`, color: 'warning' }
  }

  switch (p.mergeStatus) {
    case 'ready':
      return { text: '✓ ready to merge', color: 'success' }
    case 'behind':
      return { text: `behind ${base}`, color: 'warning' }
    case 'blocked':
      return { text: 'blocked by branch rules (reviews or required checks)' }
    case 'unstable':
      return { text: 'mergeable, but some checks fail', color: 'warning' }
    case 'draft':
      return { text: 'draft, not ready for review', color: 'subtle' }
    case 'unknown':
      return { text: 'GitHub is still checking', color: 'subtle' }
  }
}

/** `3h ago`, from a span in milliseconds. */
export const ago = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`

  return `${Math.floor(minutes / (60 * 24))}d ago`
}

/** `+120 −30 · 4 files · updated 2h ago`, the age as of `now`. */
export const sizeLine = (p: Pr, now: number): Line => {
  const updated = p.updatedAt > 0 ? [`updated ${ago(now - p.updatedAt)}`] : []
  const text = [`+${p.additions} −${p.deletions}`, plural(p.changedFiles, 'file'), ...updated].join(
    ' · ',
  )

  return { text, color: 'subtle' }
}
