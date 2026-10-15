import { describe, expect, test } from 'claude-code/testing'

import {
  LINK_PROMPT_LIMIT,
  ciPrompt,
  newSessionUrl,
  stalenessOf,
  updatePrompt,
} from '../hooks/prompts'
import { pr } from './fixtures'

describe('ciPrompt', () => {
  test('names the PR, the branch and the failing checks, and forbids pushing', () => {
    const text = ciPrompt(pr({ failedChecks: ['unit-tests', 'lint'] }))
    expect(text).toContain('acme/app#1 "Fix the thing"')
    expect(text).toContain('branch `fix-thing`')
    expect(text).toContain('Failed checks: unit-tests, lint.')
    expect(text).toContain('Do not push')
  })
})

describe('stalenessOf', () => {
  test('a conflict wins over being behind', () => {
    expect(stalenessOf(pr({ merge: 'conflict', mergeStatus: 'behind' }))).toBe('conflict')
    expect(stalenessOf(pr({ mergeStatus: 'conflict' }))).toBe('conflict')
  })

  test('behind, or nothing to fix', () => {
    expect(stalenessOf(pr({ mergeStatus: 'behind' }))).toBe('behind')
    expect(stalenessOf(pr({ mergeStatus: 'ready' }))).toBeUndefined()
    expect(stalenessOf(pr({ mergeStatus: 'blocked' }))).toBeUndefined()
  })
})

describe('updatePrompt', () => {
  test('a conflict: Claude picks merge or rebase, resolves, explains, never pushes unasked', () => {
    const text = updatePrompt(pr({ merge: 'conflict', baseBranch: 'develop' }), 'conflict')
    expect(text).toContain('has merge conflicts with `develop`; its branch is `fix-thing`.')
    expect(text).toContain('decide the best way to fix it')
    expect(text).toContain('merging `develop` into the branch or rebasing it onto `develop`')
    expect(text).toContain('Tell me what you chose and why.')
    expect(text).toContain('separate git worktree')
    expect(text).toContain('how you resolved each one')
    expect(text).toContain(
      'Do not push, force-push or update the PR on GitHub without asking me first.',
    )
    // GitHub's update-branch cannot resolve conflicts, so it is not offered.
    expect(text).not.toContain('update-branch')
  })

  test('behind: update-branch is an option, and doing nothing is allowed', () => {
    const text = updatePrompt(pr({ mergeStatus: 'behind' }), 'behind')
    expect(text).toContain('is behind `main`; its branch is `fix-thing`.')
    expect(text).toContain('`gh pr update-branch 1 --repo acme/app`')
    expect(text).toContain("If updating isn't needed")
    expect(text).not.toContain('conflict')
  })
})

describe('newSessionUrl', () => {
  test('names the folder and the prompt, both encoded', () => {
    const url = newSessionUrl('/Users/me/My Code/app', 'Fix `main` & tell me: why?')
    const parsed = new URL(url)
    expect(parsed.protocol).toBe('claude:')
    expect(parsed.host + parsed.pathname).toBe('code/new')
    expect(parsed.searchParams.get('folder')).toBe('/Users/me/My Code/app')
    expect(parsed.searchParams.get('q')).toBe('Fix `main` & tell me: why?')
  })

  test('cuts the prompt to what the app takes', () => {
    const q = new URL(newSessionUrl('/x', 'a'.repeat(20_000))).searchParams.get('q')
    expect(q?.length).toBe(LINK_PROMPT_LIMIT)
  })
})
