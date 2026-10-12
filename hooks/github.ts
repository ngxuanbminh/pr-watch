import type { Checks, CiState, MergeState, MergeStatus, Pr, ReviewState, Reviews } from '../types'

// Two searches in one request: the PRs you opened in the repo, and the ones
// there waiting on your review. About 6 rate-limit points per poll.
export const QUERY = `
query($mine: String!, $review: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ...pr } }
  review: search(query: $review, type: ISSUE, first: 50) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft mergeable mergeStateStatus reviewDecision
  headRefName baseRefName updatedAt additions deletions changedFiles
  author { login }
  repository { nameWithOwner }
  latestOpinionatedReviews(first: 10) { nodes { state author { login } } }
  reviewRequests(first: 10) { nodes { requestedReviewer {
    __typename
    ... on User { login }
    ... on Team { name }
    ... on Bot { login }
    ... on Mannequin { login }
  } } }
  reviewThreads(first: 50) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts(first: 50) {
      checkRunCountsByState { state count }
      statusContextCountsByState { state count }
      nodes {
        __typename
        ... on CheckRun { name conclusion }
        ... on StatusContext { context state }
      }
    }
  } } } }
}`

// The session's PATH may not reach Homebrew's bin (an app-started session).
export const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
/** The `gh` arguments of one poll, both searches held to `repo` (`owner/name`). */
export const ghArgs = (repo: string): string[] => [
  'api',
  'graphql',
  '-f',
  `query=${QUERY}`,
  '-f',
  `mine=is:open is:pr archived:false author:@me repo:${repo}`,
  '-f',
  `review=is:open is:pr archived:false review-requested:@me repo:${repo}`,
]

/**
 * `owner/name` of a github.com remote URL (https, ssh or scp form), or null
 * for any other host or a URL that names no repo.
 */
export const parseRemote = (url: string): string | null => {
  const found = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())

  return found === null ? null : `${found[1]}/${found[2]}`
}

// Check run conclusions and status context states, by how the pane counts them.
const FAILED = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'CANCELLED',
])
const PASSED = new Set(['SUCCESS'])
const PENDING = new Set(['PENDING', 'EXPECTED', 'IN_PROGRESS', 'QUEUED', 'WAITING'])
const SKIPPED = new Set(['SKIPPED', 'NEUTRAL', 'STALE'])

type RawCount = { state?: string; count?: number }
type RawContext = {
  __typename?: string
  name?: string
  conclusion?: string | null
  context?: string
  state?: string
}
type RawPr = {
  number?: number
  title?: string
  url?: string
  isDraft?: boolean
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string | null
  headRefName?: string
  baseRefName?: string
  updatedAt?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  author?: { login?: string } | null
  repository?: { nameWithOwner?: string }
  latestOpinionatedReviews?: { nodes?: { state?: string; author?: { login?: string } | null }[] }
  reviewRequests?: {
    nodes?: { requestedReviewer?: { login?: string; name?: string } | null }[]
  }
  reviewThreads?: { nodes?: { isResolved?: boolean }[] }
  commits?: {
    nodes?: {
      commit?: {
        statusCheckRollup?: {
          state?: string
          contexts?: {
            checkRunCountsByState?: RawCount[]
            statusContextCountsByState?: RawCount[]
            nodes?: RawContext[]
          }
        } | null
      }
    }[]
  }
}
type RawResponse = {
  data?: {
    viewer?: { login?: string }
    mine?: { nodes?: RawPr[] }
    review?: { nodes?: RawPr[] }
  }
  errors?: { message?: string }[]
}

export type FetchResult = { ok: true; prs: Pr[] } | { ok: false; error: string }

const ciOf = (state: string | undefined): CiState => {
  if (state === 'SUCCESS') return 'success'
  if (state === 'FAILURE' || state === 'ERROR') return 'failure'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
  return 'none'
}

const reviewOf = (decision: string | null | undefined): ReviewState => {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes'
  if (decision === 'REVIEW_REQUIRED') return 'required'
  return 'none'
}

const mergeOf = (mergeable: string | undefined): MergeState => {
  if (mergeable === 'MERGEABLE') return 'clean'
  if (mergeable === 'CONFLICTING') return 'conflict'
  return 'unknown'
}

const MERGE_STATUS: Record<string, MergeStatus> = {
  CLEAN: 'ready',
  HAS_HOOKS: 'ready',
  BEHIND: 'behind',
  BLOCKED: 'blocked',
  UNSTABLE: 'unstable',
  DIRTY: 'conflict',
  DRAFT: 'draft',
}

const checksOf = (counts: readonly RawCount[]): Checks => {
  const checks: Checks = { passed: 0, failed: 0, pending: 0, skipped: 0 }
  for (const { state = '', count = 0 } of counts) {
    if (PASSED.has(state)) checks.passed += count
    else if (FAILED.has(state)) checks.failed += count
    else if (PENDING.has(state)) checks.pending += count
    else if (SKIPPED.has(state)) checks.skipped += count
  }

  return checks
}

const reviewsOf = (raw: RawPr, viewer: string | undefined): Reviews => {
  const by = (state: string) =>
    (raw.latestOpinionatedReviews?.nodes ?? [])
      .filter(r => r.state === state)
      .map(r => r.author?.login ?? 'ghost')
  const waitingOn = (raw.reviewRequests?.nodes ?? [])
    .map(r => r.requestedReviewer?.login ?? r.requestedReviewer?.name)
    .filter((name): name is string => name !== undefined)
    .map(name => (name === viewer ? 'you' : name))

  return {
    approvedBy: by('APPROVED'),
    changesBy: by('CHANGES_REQUESTED'),
    waitingOn,
    unresolvedThreads: (raw.reviewThreads?.nodes ?? []).filter(t => t.isResolved === false).length,
  }
}

const toPr = (raw: RawPr, role: Pr['role'], viewer: string | undefined): Pr | undefined => {
  if (raw.url === undefined || raw.number === undefined) return undefined

  const rollup = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null
  const contexts = rollup?.contexts
  const failedChecks = (contexts?.nodes ?? [])
    .filter(c => FAILED.has(c.conclusion ?? c.state ?? ''))
    .map(c => c.name ?? c.context ?? 'unnamed check')
  const updatedAt = Date.parse(raw.updatedAt ?? '')

  return {
    url: raw.url,
    repo: raw.repository?.nameWithOwner ?? '',
    number: raw.number,
    title: raw.title ?? '',
    author: raw.author?.login ?? 'ghost',
    branch: raw.headRefName ?? '',
    baseBranch: raw.baseRefName ?? '',
    isDraft: raw.isDraft === true,
    ci: ciOf(rollup?.state),
    checks: checksOf([
      ...(contexts?.checkRunCountsByState ?? []),
      ...(contexts?.statusContextCountsByState ?? []),
    ]),
    failedChecks,
    review: reviewOf(raw.reviewDecision),
    reviews: reviewsOf(raw, viewer),
    merge: mergeOf(raw.mergeable),
    mergeStatus: MERGE_STATUS[raw.mergeStateStatus ?? ''] ?? 'unknown',
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
    role,
  }
}

/** The PRs in a GraphQL answer: yours first, then review requests not already listed. */
export const parsePrs = (body: string): FetchResult => {
  let raw: RawResponse
  try {
    raw = JSON.parse(body) as RawResponse
  } catch {
    return { ok: false, error: 'GitHub answered something that is not JSON' }
  }
  const message = raw.errors?.[0]?.message
  if (message !== undefined || raw.data === undefined) {
    return { ok: false, error: message ?? 'GitHub answered no data' }
  }

  const viewer = raw.data.viewer?.login
  const mine = (raw.data.mine?.nodes ?? []).map(p => toPr(p, 'mine', viewer))
  const review = (raw.data.review?.nodes ?? []).map(p => toPr(p, 'review', viewer))
  const prs: Pr[] = []
  const seen = new Set<string>()
  for (const p of [...mine, ...review]) {
    if (p === undefined || seen.has(p.url)) continue
    seen.add(p.url)
    prs.push(p)
  }

  return { ok: true, prs }
}

/** A short reason for a failed `gh` run, fit for the status line. */
export const reasonOf = (stderr: string): string => {
  if (/auth login|not logged in/i.test(stderr)) return 'gh not logged in'
  if (/could not resolve|network|timeout|dial tcp/i.test(stderr)) return 'GitHub unreachable'
  const line = stderr.trim().split('\n')[0] ?? ''

  return line === '' ? 'gh failed' : line.slice(0, 80)
}
