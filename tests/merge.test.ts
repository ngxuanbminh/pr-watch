import { describe, expect, test } from 'claude-code/testing'

import { canMerge, mergeArgs, mergeFailure, mergeLabel } from '../hooks/merge'
import { pr } from './fixtures'

const approved = (over: Parameters<typeof pr>[0] = {}) =>
  pr({
    ci: 'success',
    review: 'approved',
    mergeStatus: 'ready',
    reviews: { approvedBy: ['alice'], changesBy: [], waitingOn: [], unresolvedThreads: 0 },
    ...over,
  })

describe('canMerge', () => {
  test('an approved PR of mine that GitHub would merge now', () => {
    expect(canMerge(approved())).toBe(true)
    // Behind is allowed: GitHub refuses it if the repo requires up-to-date branches.
    expect(canMerge(approved({ mergeStatus: 'behind' }))).toBe(true)
    // No checks at all is fine too.
    expect(canMerge(approved({ ci: 'none' }))).toBe(true)
  })

  test('an approval without a required review counts', () => {
    expect(canMerge(approved({ review: 'none' }))).toBe(true)
  })

  test('not approved, or changes requested', () => {
    expect(canMerge(approved({ review: 'required', reviews: pr().reviews }))).toBe(false)
    expect(
      canMerge(
        approved({
          review: 'none',
          reviews: {
            approvedBy: ['alice'],
            changesBy: ['bob'],
            waitingOn: [],
            unresolvedThreads: 0,
          },
        }),
      ),
    ).toBe(false)
  })

  test('nothing GitHub would refuse', () => {
    expect(canMerge(approved({ ci: 'failure' }))).toBe(false)
    expect(canMerge(approved({ ci: 'pending' }))).toBe(false)
    expect(canMerge(approved({ merge: 'conflict' }))).toBe(false)
    expect(canMerge(approved({ mergeStatus: 'blocked' }))).toBe(false)
    expect(canMerge(approved({ mergeStatus: 'unknown' }))).toBe(false)
    expect(canMerge(approved({ isDraft: true }))).toBe(false)
  })

  test('only my own PRs, and only with a known head commit', () => {
    expect(canMerge(approved({ role: 'review' }))).toBe(false)
    expect(canMerge(approved({ headSha: '' }))).toBe(false)
  })
})

describe('mergeArgs', () => {
  test('pins the head commit and names the repo, so no checkout is involved', () => {
    expect(mergeArgs(approved(), 'squash')).toEqual([
      'pr',
      'merge',
      '1',
      '--repo',
      'acme/app',
      '--squash',
      '--match-head-commit',
      'abc123',
    ])
  })
})

describe('mergeLabel', () => {
  test("reads like GitHub's own button", () => {
    expect(mergeLabel('squash')).toBe('Squash and merge')
    expect(mergeLabel('merge')).toBe('Merge')
    expect(mergeLabel('rebase')).toBe('Rebase and merge')
  })
})

describe('mergeFailure', () => {
  test("keeps GitHub's reason without gh's leading mark", () => {
    expect(
      mergeFailure(
        'X Pull request acme/app#1 is not mergeable: the base branch policy prohibits the merge.\n',
      ),
    ).toBe('Pull request acme/app#1 is not mergeable: the base branch policy prohibits the merge.')
  })

  test('a head that moved is said plainly', () => {
    expect(mergeFailure('GraphQL: Head branch was modified. Review and try the merge again.')).toBe(
      'the PR has new commits since the pane last loaded; refresh and look again',
    )
  })
})
