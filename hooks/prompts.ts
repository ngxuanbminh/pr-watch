import type { Pr } from '../types'

/** Why a PR of mine is out of date with its base branch, if it is. */
export type Staleness = 'conflict' | 'behind'

export const stalenessOf = (p: Pr): Staleness | undefined => {
  if (p.merge === 'conflict' || p.mergeStatus === 'conflict') return 'conflict'
  if (p.mergeStatus === 'behind') return 'behind'
  return undefined
}

const header = (p: Pr) => `My pull request ${p.repo}#${p.number} "${p.title}" (${p.url})`

/** The prompt behind Ask Claude on a PR of mine whose CI fails. */
export const ciPrompt = (p: Pr): string =>
  [
    `CI is failing on ${header(p)}, branch \`${p.branch}\`.`,
    `Failed checks: ${p.failedChecks.length > 0 ? p.failedChecks.join(', ') : 'not named by GitHub'}.`,
    `Use \`gh pr checks ${p.number} --repo ${p.repo}\` and \`gh run view <run-id> --repo ${p.repo} --log-failed\` to read the failing logs.`,
    'Explain the root cause and propose a fix. Do not push or change the PR without asking me first.',
  ].join('\n')

/**
 * The prompt behind Ask Claude on a PR of mine that conflicts with, or is
 * behind, its base branch: Claude looks into it and picks the fix itself.
 */
export const updatePrompt = (p: Pr, why: Staleness): string => {
  const base = p.baseBranch || 'main'
  const isConflict = why === 'conflict'
  const options = isConflict
    ? `merging \`${base}\` into the branch or rebasing it onto \`${base}\``
    : `merging \`${base}\` into the branch, rebasing it onto \`${base}\`, or GitHub's update-branch (\`gh pr update-branch ${p.number} --repo ${p.repo}\`, with or without \`--rebase\`)`

  return [
    `${header(p)} ${isConflict ? 'has merge conflicts with' : 'is behind'} \`${base}\`; its branch is \`${p.branch}\`.`,
    'Look into it and decide the best way to fix it:',
    `1. Run \`git fetch origin\` and see how far \`${p.branch}\` is behind \`origin/${base}\`${isConflict ? ' and which files conflict' : ''}.`,
    ...(isConflict
      ? []
      : [
          "   If updating isn't needed (nothing requires the branch to be up to date and it merges cleanly), tell me so and stop.",
        ]),
    `2. Choose between ${options}. Weigh the repo's conventions (its docs and recent history), whether branch protection requires the branch to be up to date, and any reviews a force-push would disrupt. Tell me what you chose and why.`,
    `3. Do the work on \`${p.branch}\` in a separate git worktree so my current checkout and any uncommitted changes stay untouched${isConflict ? ', resolving each conflict so that the intent of both sides is kept' : ''}.`,
    `4. Run the project's tests and type-check${isConflict ? ', then show me which files conflicted and how you resolved each one' : ''}.`,
    'Do not push, force-push or update the PR on GitHub without asking me first.',
  ].join('\n')
}

/** A dependency bot's PR: dependabot, renovate, or any `[bot]` or GitHub App author. */
const isBot = (author: string): boolean => /^(dependabot|renovate|app\/)|\[bot\]$/i.test(author)

/** The prompt behind Ask Claude on a PR whose review is requested from me. */
export const reviewPrompt = (p: Pr): string => {
  const pr = `${p.number} --repo ${p.repo}`
  const steps = [
    `Read it: \`gh pr view ${pr} --comments\`, \`gh pr diff ${pr}\` and \`gh pr checks ${pr}\`, and the inline review threads (\`gh api repos/${p.repo}/pulls/${p.number}/comments\`), so you don't repeat what others already said.`,
    'If you need to run the code, check the branch out in a separate git worktree so my current checkout and any uncommitted changes stay untouched.',
    ...(isBot(p.author)
      ? [
          "It's a dependency update: check the changelog of what it bumps for breaking changes, and whether any failing checks come from the bump.",
        ]
      : []),
    "Tell me what the PR does in a few sentences, the issues you found ranked by severity, each with file:line, and whether you'd approve, request changes or just comment, and why.",
  ]

  return [
    `Review pull request ${p.repo}#${p.number} "${p.title}" (${p.url}) by ${p.author}, \`${p.branch}\` into \`${p.baseBranch || 'main'}\`; my review is requested.`,
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    'Do not post a review, comment, approval or any other change on GitHub without asking me first.',
  ].join('\n')
}

/** The most prompt text the desktop app takes from a link. */
export const LINK_PROMPT_LIMIT = 14_336

/**
 * The desktop app's link for a new Claude Code session on `folder` with
 * `prompt` in its composer; the person sends it from there.
 */
export const newSessionUrl = (folder: string, prompt: string): string =>
  `claude://code/new?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(
    prompt.slice(0, LINK_PROMPT_LIMIT),
  )}&source=pr-watch`
