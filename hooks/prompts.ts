import type { Pr } from '../types'

/** How Claude brings the base branch into a conflicting PR branch. */
export type Strategy = 'merge' | 'rebase'

const header = (p: Pr) => `My pull request ${p.repo}#${p.number} "${p.title}" (${p.url})`

/** The prompt behind Ask Claude on a PR of mine whose CI fails. */
export const ciPrompt = (p: Pr): string =>
  [
    `CI is failing on ${header(p)}, branch \`${p.branch}\`.`,
    `Failed checks: ${p.failedChecks.length > 0 ? p.failedChecks.join(', ') : 'not named by GitHub'}.`,
    `Use \`gh pr checks ${p.number} --repo ${p.repo}\` and \`gh run view <run-id> --repo ${p.repo} --log-failed\` to read the failing logs.`,
    'Explain the root cause and propose a fix. Do not push or change the PR without asking me first.',
  ].join('\n')

/** The prompt behind Ask Claude on a PR of mine that conflicts with its base branch. */
export const conflictPrompt = (p: Pr, strategy: Strategy): string => {
  const base = p.baseBranch || 'main'
  const how =
    strategy === 'merge'
      ? `Merge \`origin/${base}\` into it and resolve each conflict, keeping the intent of both sides.`
      : `Rebase it onto \`origin/${base}\` and resolve each conflict as it comes up, keeping the intent of both sides.`
  const push =
    strategy === 'merge'
      ? 'Do not push or change the PR without asking me first.'
      : 'Updating the PR then needs `git push --force-with-lease`; do not push or change the PR without asking me first.'

  return [
    `${header(p)} has merge conflicts with \`${base}\`; its branch is \`${p.branch}\`.`,
    `Resolve them by ${strategy === 'merge' ? `merging \`${base}\` into the branch` : `rebasing the branch onto \`${base}\``}:`,
    `1. Run \`git fetch origin\`, then work on \`${p.branch}\` in a separate git worktree so my current checkout and any uncommitted changes stay untouched.`,
    `2. ${how}`,
    "3. Run the project's tests and type-check.",
    '4. Show me which files conflicted and how you resolved each one.',
    push,
  ].join('\n')
}
