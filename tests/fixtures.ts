import type { Pr } from '../types'

/** A PR of mine with nothing notable about it, changed by `over`. */
export const pr = (over: Partial<Pr> = {}): Pr => ({
  url: 'https://github.com/acme/app/pull/1',
  repo: 'acme/app',
  number: 1,
  title: 'Fix the thing',
  author: 'me',
  branch: 'fix-thing',
  baseBranch: 'main',
  isDraft: false,
  ci: 'pending',
  checks: { passed: 0, failed: 0, pending: 1, skipped: 0 },
  failedChecks: [],
  review: 'none',
  reviews: { approvedBy: [], changesBy: [], waitingOn: [], unresolvedThreads: 0 },
  merge: 'clean',
  mergeStatus: 'blocked',
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  updatedAt: 0,
  role: 'mine',
  ...over,
})
