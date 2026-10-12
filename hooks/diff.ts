import type { CiState, Pr, Snapshot } from '../types'

/** One status change worth telling the person about. */
export type Change = { icon: string; what: string; pr: Pr }

/** `app#123`: the repo without its owner, then the number. */
export const ref = (pr: Pr): string => `${pr.repo.split('/').pop()}#${pr.number}`

export const CI_ICON: Record<CiState, string> = {
  success: '✓',
  failure: '✗',
  pending: '●',
  none: '·',
}

/**
 * GitHub answers `UNKNOWN` for mergeability while it recomputes (after every
 * push); keep the previous known state so a conflict is not reported twice.
 */
export const settle = (prev: readonly Pr[] | undefined, next: readonly Pr[]): Pr[] => {
  const before = new Map((prev ?? []).map(p => [p.url, p]))

  return next.map(p => {
    const old = before.get(p.url)

    return p.merge === 'unknown' && old !== undefined ? { ...p, merge: old.merge } : p
  })
}

/** What changed between two polls, in the order of the new poll. */
export const changes = (prev: readonly Pr[], next: readonly Pr[]): Change[] => {
  const before = new Map(prev.map(p => [p.url, p]))
  const after = new Set(next.map(p => p.url))
  const found: Change[] = []

  for (const p of next) {
    const old = before.get(p.url)

    if (old === undefined) {
      if (p.role === 'review') found.push({ icon: '👀', what: 'review requested', pr: p })
      continue
    }
    if (p.role !== 'mine') continue

    if (p.ci === 'failure' && old.ci !== 'failure') {
      found.push({ icon: '✗', what: 'CI failed', pr: p })
    }
    if (p.ci === 'success' && old.ci !== 'success') {
      found.push({ icon: '✓', what: 'CI passed', pr: p })
    }
    if (p.review !== old.review && p.review === 'approved') {
      found.push({ icon: '✓', what: 'approved', pr: p })
    }
    if (p.review !== old.review && p.review === 'changes') {
      found.push({ icon: '✎', what: 'changes requested', pr: p })
    }
    if (p.merge === 'conflict' && old.merge !== 'conflict') {
      found.push({ icon: '⚠', what: 'merge conflict', pr: p })
    }
  }

  for (const p of prev) {
    if (p.role === 'mine' && !after.has(p.url)) {
      found.push({ icon: '⏏', what: 'closed or merged', pr: p })
    }
  }

  return found
}

/** One toast line for a poll's changes, or undefined when there are none. */
export const toastText = (found: readonly Change[]): string | undefined => {
  const [only] = found
  if (only === undefined) return undefined
  if (found.length === 1) return `${only.icon} ${ref(only.pr)} ${only.what}: ${only.pr.title}`

  const list = found.map(c => `${c.icon} ${ref(c.pr)} ${c.what}`).join(' · ')

  return `${found.length} PR updates: ${list}`
}

/**
 * The status line, `app · PRs ✓6 ✗1 ●2 · 2 conflicts · 2 to review`, or
 * undefined (no line) when the session is not in a GitHub repo.
 */
export const summary = (snap: Snapshot): string | undefined => {
  if (snap.repo === null) return undefined

  return `${snap.repo.split('/').pop()} · ${countsOf(snap)}`
}

const countsOf = (snap: Snapshot): string => {
  const error = snap.error === null ? [] : [`⚠ ${snap.error}`]
  if (snap.fetchedAt === null) return `PRs ${error.join('') || '…'}`

  const mine = snap.prs.filter(p => p.role === 'mine')
  const toReview = snap.prs.length - mine.length
  const count = (ci: CiState) => mine.filter(p => p.ci === ci).length
  const conflicts = mine.filter(p => p.merge === 'conflict').length

  const ci =
    (['success', 'failure', 'pending'] as const)
      .filter(state => count(state) > 0)
      .map(state => `${CI_ICON[state]}${count(state)}`)
      .join(' ') || (mine.length > 0 ? `${mine.length} open` : '')
  const parts = [
    ...(conflicts > 0 ? [`${conflicts} conflict${conflicts === 1 ? '' : 's'}`] : []),
    ...(toReview > 0 ? [`${toReview} to review`] : []),
    ...error,
  ]

  if (ci === '' && parts.length === 0) return 'PRs: none open'
  if (ci === '') return `PRs ${parts.join(' · ')}`

  return [`PRs ${ci}`, ...parts].join(' · ')
}
