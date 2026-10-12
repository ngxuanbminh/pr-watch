import { describe, expect, test } from 'claude-code/testing'

import { ago, ciLine, mergeLine, reviewLine, sizeLine } from '../hooks/details'
import { pr } from './fixtures'

const reviews = (over: Partial<ReturnType<typeof pr>['reviews']>) => ({
  ...pr().reviews,
  ...over,
})

describe('ciLine', () => {
  test('all green', () => {
    expect(ciLine(pr({ checks: { passed: 12, failed: 0, pending: 0, skipped: 0 } }))).toEqual({
      text: '✓ 12 passed',
      color: 'success',
    })
  })

  test('failures lead, named, then the rest', () => {
    const line = ciLine(
      pr({
        checks: { passed: 10, failed: 2, pending: 1, skipped: 3 },
        failedChecks: ['checks', 'test'],
      }),
    )
    expect(line).toEqual({
      text: '✗ 2 failed (checks, test) · 1 running · 10 passed · 3 skipped',
      color: 'error',
    })
  })

  test('running without failures', () => {
    expect(ciLine(pr({ checks: { passed: 4, failed: 0, pending: 2, skipped: 0 } })).text).toBe(
      '● 2 running · 4 passed',
    )
  })

  test('named failures show even without a tally', () => {
    const line = ciLine(
      pr({ checks: { passed: 0, failed: 0, pending: 0, skipped: 0 }, failedChecks: ['lint'] }),
    )
    expect(line.text).toBe('✗ 1 failed (lint)')
  })

  test('no checks at all', () => {
    expect(ciLine(pr({ checks: { passed: 0, failed: 0, pending: 0, skipped: 0 } })).text).toBe(
      'no checks',
    )
  })
})

describe('reviewLine', () => {
  test('approval with unresolved threads', () => {
    expect(
      reviewLine(
        pr({ review: 'approved', reviews: reviews({ approvedBy: ['alice'], unresolvedThreads: 2 }) }),
      ),
    ).toEqual({ text: '✓ approved by alice · 2 unresolved threads', color: 'success' })
  })

  test('changes requested wins the color', () => {
    const line = reviewLine(
      pr({ review: 'changes', reviews: reviews({ approvedBy: ['alice'], changesBy: ['bob'] }) }),
    )
    expect(line).toEqual({
      text: '✓ approved by alice · ✎ changes requested by bob',
      color: 'error',
    })
  })

  test('waiting on you is called out', () => {
    expect(reviewLine(pr({ reviews: reviews({ waitingOn: ['you', 'platform-team'] }) }))).toEqual({
      text: 'waiting on you, platform-team',
      color: 'warning',
    })
  })

  test('long reviewer lists are cut to three', () => {
    expect(reviewLine(pr({ reviews: reviews({ waitingOn: ['a', 'b', 'c', 'd', 'e'] }) })).text).toBe(
      'waiting on a, b, c +2',
    )
  })

  test('nobody yet', () => {
    expect(reviewLine(pr({ review: 'required' })).text).toBe('review required')
    expect(reviewLine(pr()).text).toBe('no reviews yet')
  })
})

describe('mergeLine', () => {
  test('a conflict wins whatever the status says', () => {
    expect(mergeLine(pr({ merge: 'conflict', mergeStatus: 'blocked' })).text).toBe(
      '⚠ conflicts with main',
    )
  })

  test('each status reads plainly', () => {
    expect(mergeLine(pr({ mergeStatus: 'ready' })).text).toBe('✓ ready to merge')
    expect(mergeLine(pr({ mergeStatus: 'behind' })).text).toBe('behind main')
    expect(mergeLine(pr({ mergeStatus: 'unknown' })).text).toBe('GitHub is still checking')
  })
})

describe('sizeLine', () => {
  test('size, files and age', () => {
    const now = Date.parse('2026-10-09T12:00:00Z')
    const updatedAt = Date.parse('2026-10-07T10:00:00Z')
    expect(
      sizeLine(pr({ additions: 11004, deletions: 214, changedFiles: 31, updatedAt }), now).text,
    ).toBe('+11004 −214 · 31 files · updated 2d ago')
  })

  test('one file and no known age', () => {
    expect(sizeLine(pr(), 0).text).toBe('+10 −2 · 1 file')
  })

  test('ages', () => {
    expect(ago(30_000)).toBe('just now')
    expect(ago(5 * 60_000)).toBe('5m ago')
    expect(ago(3 * 3_600_000)).toBe('3h ago')
  })
})
