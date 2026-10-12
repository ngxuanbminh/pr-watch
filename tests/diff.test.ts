import { describe, expect, test } from 'claude-code/testing'

import { changes, settle, summary, toastText } from '../hooks/diff'
import { pr } from './fixtures'

describe('changes', () => {
  test('CI turning red on my PR is reported', () => {
    const found = changes([pr()], [pr({ ci: 'failure', failedChecks: ['test'] })])
    expect(found.map(c => c.what)).toEqual(['CI failed'])
  })

  test('CI turning green after pending or failing is reported', () => {
    expect(changes([pr()], [pr({ ci: 'success' })]).map(c => c.what)).toEqual(['CI passed'])
    expect(
      changes([pr({ ci: 'failure' })], [pr({ ci: 'success' })]).map(c => c.what),
    ).toEqual(['CI passed'])
  })

  test('an unchanged PR reports nothing', () => {
    expect(changes([pr({ ci: 'success' })], [pr({ ci: 'success' })])).toEqual([])
  })

  test('review decisions are reported', () => {
    expect(changes([pr()], [pr({ review: 'approved' })]).map(c => c.what)).toEqual([
      'approved',
    ])
    expect(changes([pr()], [pr({ review: 'changes' })]).map(c => c.what)).toEqual([
      'changes requested',
    ])
  })

  test('a new merge conflict is reported once', () => {
    expect(changes([pr()], [pr({ merge: 'conflict' })]).map(c => c.what)).toEqual([
      'merge conflict',
    ])
    expect(changes([pr({ merge: 'conflict' })], [pr({ merge: 'conflict' })])).toEqual([])
  })

  test('a new review request is reported, a new PR of mine is not', () => {
    const asked = pr({ url: 'u2', number: 2, role: 'review', author: 'alice' })
    const opened = pr({ url: 'u3', number: 3 })
    expect(changes([], [asked, opened]).map(c => c.what)).toEqual(['review requested'])
  })

  test('my PR leaving the list is reported, a review request leaving is not', () => {
    const asked = pr({ url: 'u2', number: 2, role: 'review' })
    expect(changes([pr(), asked], []).map(c => c.what)).toEqual(['closed or merged'])
  })

  test("CI changes on someone else's PR are not reported", () => {
    const before = pr({ role: 'review' })
    expect(changes([before], [{ ...before, ci: 'failure' }])).toEqual([])
  })
})

describe('settle', () => {
  test('an unknown merge state keeps the previous one', () => {
    const [one] = settle([pr({ merge: 'conflict' })], [pr({ merge: 'unknown' })])
    expect(one?.merge).toBe('conflict')
  })

  test('a known merge state wins', () => {
    const [one] = settle([pr({ merge: 'conflict' })], [pr({ merge: 'clean' })])
    expect(one?.merge).toBe('clean')
  })
})

describe('summary', () => {
  const REPO = 'acme/app'

  test('names the repo and counts my PRs by CI state, conflicts and review requests', () => {
    const prs = [
      pr({ url: 'a', ci: 'success' }),
      pr({ url: 'b', ci: 'success', merge: 'conflict' }),
      pr({ url: 'c', ci: 'failure' }),
      pr({ url: 'd', ci: 'pending' }),
      pr({ url: 'e', role: 'review' }),
    ]
    expect(summary({ repo: REPO, prs, fetchedAt: 1, error: null })).toBe(
      'app · PRs ✓2 ✗1 ●1 · 1 conflict · 1 to review',
    )
  })

  test('says when nothing is open', () => {
    expect(summary({ repo: REPO, prs: [], fetchedAt: 1, error: null })).toBe(
      'app · PRs: none open',
    )
  })

  test('shows the error beside the last good counts', () => {
    expect(
      summary({ repo: REPO, prs: [pr({ ci: 'success' })], fetchedAt: 1, error: 'gh not logged in' }),
    ).toBe('app · PRs ✓1 · ⚠ gh not logged in')
  })

  test('shows the error alone before any good poll', () => {
    expect(summary({ repo: REPO, prs: [], fetchedAt: null, error: 'gh not found' })).toBe(
      'app · PRs ⚠ gh not found',
    )
  })

  test('has no line outside a GitHub repo', () => {
    expect(summary({ repo: null, prs: [], fetchedAt: null, error: null })).toBeUndefined()
  })
})

describe('toastText', () => {
  test('one change reads as one line', () => {
    const found = changes([pr()], [pr({ ci: 'failure' })])
    expect(toastText(found)).toBe('✗ app#1 CI failed: Fix the thing')
  })

  test('several changes are counted and listed', () => {
    const found = changes(
      [pr(), pr({ url: 'u2', number: 2 })],
      [pr({ ci: 'failure' }), pr({ url: 'u2', number: 2, review: 'approved' })],
    )
    expect(toastText(found)).toBe('2 PR updates: ✗ app#1 CI failed · ✓ app#2 approved')
  })

  test('nothing to say is undefined', () => {
    expect(toastText([])).toBeUndefined()
  })
})
