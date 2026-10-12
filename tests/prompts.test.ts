import { describe, expect, test } from 'claude-code/testing'

import { ciPrompt, conflictPrompt } from '../hooks/prompts'
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

describe('conflictPrompt', () => {
  const conflicted = pr({ merge: 'conflict', baseBranch: 'develop' })

  test('merge brings the base branch in, in a separate worktree, without pushing', () => {
    const text = conflictPrompt(conflicted, 'merge')
    expect(text).toContain('has merge conflicts with `develop`; its branch is `fix-thing`.')
    expect(text).toContain('merging `develop` into the branch')
    expect(text).toContain('Merge `origin/develop` into it')
    expect(text).toContain('separate git worktree')
    expect(text).toContain('Do not push or change the PR without asking me first.')
    expect(text).not.toContain('force')
  })

  test('rebase replays onto the base branch and warns about the force-push', () => {
    const text = conflictPrompt(conflicted, 'rebase')
    expect(text).toContain('rebasing the branch onto `develop`')
    expect(text).toContain('Rebase it onto `origin/develop`')
    expect(text).toContain('git push --force-with-lease')
    expect(text).toContain('do not push or change the PR without asking me first.')
  })
})
