export type CiState = 'success' | 'failure' | 'pending' | 'none'
export type ReviewState = 'approved' | 'changes' | 'required' | 'none'
export type MergeState = 'clean' | 'conflict' | 'unknown'
/** GitHub's merge state status, as the pane words it. */
export type MergeStatus = 'ready' | 'behind' | 'blocked' | 'unstable' | 'conflict' | 'draft' | 'unknown'

/** The head commit's checks, counted by outcome. */
export type Checks = { passed: number; failed: number; pending: number; skipped: number }

/** Who has reviewed, who still has to, and the open review threads. */
export type Reviews = {
  approvedBy: string[]
  changesBy: string[]
  /** Requested reviewers (users or teams); `you` stands for the viewer. */
  waitingOn: string[]
  unresolvedThreads: number
}

/** One open pull request, as the last poll saw it. */
export type Pr = {
  url: string
  repo: string
  number: number
  title: string
  author: string
  branch: string
  baseBranch: string
  isDraft: boolean
  ci: CiState
  checks: Checks
  failedChecks: string[]
  review: ReviewState
  reviews: Reviews
  merge: MergeState
  mergeStatus: MergeStatus
  additions: number
  deletions: number
  changedFiles: number
  /** Last update on GitHub, epoch milliseconds (0 when GitHub did not say). */
  updatedAt: number
  /** `mine`: you opened it; `review`: your review is requested. */
  role: 'mine' | 'review'
}

/**
 * The session's repo (`owner/name`, null: not a GitHub repo), its PRs as of
 * the last good poll, when that ran (null: none yet), and the last error.
 */
export type Snapshot = {
  repo: string | null
  prs: Pr[]
  fetchedAt: number | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    // `latest` replaced `snapshot` when PRs gained their detail fields, so a
    // reload never draws a PR stored in the older shape.
    'pr-watch': { latest: Snapshot | null }
  }
}
