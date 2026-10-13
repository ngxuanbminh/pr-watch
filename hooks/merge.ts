import type { MergeMethod, Pr } from '../types'

/** Approved: GitHub's review decision says so, or, where no review is required, someone approved and nobody asked for changes. */
const isApproved = (p: Pr): boolean =>
  p.review === 'approved' ||
  (p.review === 'none' && p.reviews.approvedBy.length > 0 && p.reviews.changesBy.length === 0)

/**
 * Whether a PR of mine gets the merge button: approved, and nothing GitHub
 * would refuse it for. Behind is allowed; a repo that requires up-to-date
 * branches refuses it, and the toast says why.
 */
export const canMerge = (p: Pr): boolean =>
  p.role === 'mine' &&
  isApproved(p) &&
  !p.isDraft &&
  p.merge !== 'conflict' &&
  (p.mergeStatus === 'ready' || p.mergeStatus === 'behind') &&
  p.ci !== 'failure' &&
  p.ci !== 'pending' &&
  p.headSha !== ''

/**
 * The `gh` arguments that merge `p`: by `--repo` and without
 * `--delete-branch`, so no local checkout or branch is touched, and pinned to
 * the head commit the pane showed, so a later push is refused. Deleting the
 * branch is left to the repo's own setting, as on GitHub.
 */
export const mergeArgs = (p: Pr, method: MergeMethod): string[] => [
  'pr',
  'merge',
  String(p.number),
  '--repo',
  p.repo,
  `--${method}`,
  '--match-head-commit',
  p.headSha,
]

/** The button label, as GitHub words its own. */
export const mergeLabel = (method: MergeMethod): string =>
  ({ merge: 'Merge', squash: 'Squash and merge', rebase: 'Rebase and merge' })[method]

/** Why `gh pr merge` refused, from its standard error, fit for a toast. */
export const mergeFailure = (stderr: string): string => {
  if (/head branch was modified|head commit/i.test(stderr)) {
    return 'the PR has new commits since the pane last loaded; refresh and look again'
  }
  const line = (stderr.trim().split('\n')[0] ?? '').replace(/^[X✗]\s+/, '')

  return line === '' ? 'gh pr merge failed' : line.slice(0, 200)
}
