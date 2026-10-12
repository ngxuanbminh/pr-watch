import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Count = { state: string; count: number }
type Rollup = {
  state: string
  contexts: { checkRunCountsByState: Count[]; statusContextCountsByState: Count[]; nodes: object[] }
}
type Ran = { exitCode: number; stdout: string; stderr: string }

const PENDING: Rollup = {
  state: 'PENDING',
  contexts: {
    checkRunCountsByState: [{ state: 'IN_PROGRESS', count: 1 }],
    statusContextCountsByState: [],
    nodes: [{ __typename: 'CheckRun', name: 'unit tests', conclusion: null }],
  },
}
const FAILING: Rollup = {
  state: 'FAILURE',
  contexts: {
    checkRunCountsByState: [
      { state: 'FAILURE', count: 1 },
      { state: 'SUCCESS', count: 3 },
    ],
    statusContextCountsByState: [],
    nodes: [{ __typename: 'CheckRun', name: 'unit tests', conclusion: 'FAILURE' }],
  },
}

type Over = { mergeable?: string; role?: 'mine' | 'review' }

/** A `gh api graphql` answer holding one PR in `repo`: mine unless `over.role` says otherwise. */
const answer = (rollup: Rollup, repo = 'acme/app', over: Over = {}): Ran => {
  const node = {
    number: 1,
    title: 'Fix the thing',
    url: `https://github.com/${repo}/pull/1`,
    isDraft: false,
    mergeable: over.mergeable ?? 'MERGEABLE',
    mergeStateStatus: 'BEHIND',
    reviewDecision: 'APPROVED',
    headRefName: 'fix-thing',
    baseRefName: 'main',
    updatedAt: '2026-10-09T10:00:00Z',
    additions: 120,
    deletions: 30,
    changedFiles: 4,
    latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: { login: 'alice' } }] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: 'bob' } }] },
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] },
    author: { login: 'me' },
    repository: { nameWithOwner: repo },
    commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
  }
  const isMine = (over.role ?? 'mine') === 'mine'

  return {
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      data: {
        mine: { nodes: isMine ? [node] : [] },
        review: { nodes: isMine ? [] : [node] },
      },
    }),
  }
}

/** The folders the tests run in, and their origin remotes. */
const REMOTES: Record<string, string> = {
  '/code/app': 'https://github.com/acme/app.git\n',
  '/code/api': 'git@github.com:acme/api.git\n',
}

/**
 * The world beneath the plugin: the session's folder, a fake `git` that knows
 * REMOTES, a fake `gh`, and a record of what the plugin showed and ran.
 */
const world = (on: On, folder: { cwd: string }, gh: (argv: readonly string[]) => Ran) => {
  const seen = {
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    prompts: [] as string[],
    ghCalls: [] as string[][],
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: folder.cwd }))
  on('classic.CwdChanged', () => ({}))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const [command, ...args] = e.argv
    let ran: Ran
    if (command === 'git') {
      const remote = REMOTES[e.init?.cwd ?? '']
      ran =
        remote === undefined
          ? { exitCode: 2, stdout: '', stderr: "error: No such remote 'origin'" }
          : { exitCode: 0, stdout: remote, stderr: '' }
    } else {
      seen.ghCalls.push(args)
      ran = gh(args)
    }

    return { value: { ...ran, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('prompt.submit', ($, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })

  return seen
}

const START = { cwd: '/code/app', surface: 'terminal' as const, isInteractive: true }

const PANE_PROPS = {
  title: 'Pull requests',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

test("only the session repo's PRs are asked for", async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { cwd: '/code/app' }, () => answer(PENDING))

  await $.session.start(START)
  await clock.settle()

  expect(seen.ghCalls.length).toBe(1)
  expect(seen.ghCalls[0]).toContain('mine=is:open is:pr archived:false author:@me repo:acme/app')
  expect(seen.ghCalls[0]).toContain(
    'review=is:open is:pr archived:false review-requested:@me repo:acme/app',
  )
  expect(seen.statuses.at(-1)).toBe('app · PRs ●1')
})

test('the first poll is a baseline; CI turning red later toasts once', async ($, on) => {
  const clock = mock.clock(on)
  let rollup = PENDING
  const seen = world(on, { cwd: '/code/app' }, () => answer(rollup))

  await $.session.start(START)
  await clock.settle()
  expect(seen.toasts).toEqual([])

  rollup = FAILING
  await clock.advance(120_000)
  expect(seen.statuses.at(-1)).toBe('app · PRs ✗1')
  expect(seen.toasts).toEqual(['✗ app#1 CI failed: Fix the thing'])

  await clock.advance(120_000)
  expect(seen.toasts.length).toBe(1)
})

test('a gh failure shows in the status line without a toast', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { cwd: '/code/app' }, () => ({
    exitCode: 4,
    stdout: '',
    stderr: 'To get started with GitHub CLI, please run:  gh auth login',
  }))

  await $.session.start(START)
  await clock.settle()
  expect(seen.statuses.at(-1)).toBe('app · PRs ⚠ gh not logged in')
  expect(seen.toasts).toEqual([])
})

test('outside a GitHub repo nothing is asked and the status line is cleared', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { cwd: '/tmp/scratch' }, () => answer(PENDING))

  await $.session.start({ ...START, cwd: '/tmp/scratch' })
  await clock.settle()
  await clock.advance(120_000)

  expect(seen.ghCalls).toEqual([])
  expect(seen.statuses.at(-1)).toBeUndefined()

  const ui = await $.ui.mount({
    plugin: 'pr-watch',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pr-watch',
    props: PANE_PROPS,
  })
  expect(await ui.find({ text: /not a GitHub repo/ })).toBeDefined()
  await ui.unmount()
})

test('moving to another repo follows it at once, without toasts', async ($, on) => {
  const clock = mock.clock(on)
  const folder = { cwd: '/code/app' }
  const seen = world(on, folder, argv =>
    answer(FAILING, argv.some(a => a.endsWith('repo:acme/api')) ? 'acme/api' : 'acme/app'),
  )

  await $.session.start(START)
  await clock.settle()
  expect(seen.statuses.at(-1)).toBe('app · PRs ✗1')

  folder.cwd = '/code/api'
  await $.classic.CwdChanged({ old_cwd: '/code/app', new_cwd: '/code/api' })
  await clock.settle()

  expect(seen.ghCalls.length).toBe(2)
  expect(seen.statuses.at(-1)).toBe('api · PRs ✗1')
  // app#1 left the list only because the repo changed: no "closed or merged".
  expect(seen.toasts).toEqual([])
})

test('the pane lists the PR and Ask Claude queues a prompt', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { cwd: '/code/app' }, () => answer(FAILING))

  await $.session.start(START)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'pr-watch',
      surface,
      component: 'Pane',
      requestId: 'pr-watch',
      props: PANE_PROPS,
    })
    expect(await ui.find({ text: /acme\/app/ })).toBeDefined()
    expect(await ui.find({ text: /Your PRs \(1\)/ })).toBeDefined()
    expect(await ui.find({ text: '✗ 1 failed (unit tests) · 3 passed' })).toBeDefined()
    expect(
      await ui.find({ text: '✓ approved by alice · waiting on bob · 1 unresolved thread' }),
    ).toBeDefined()
    expect(await ui.find({ text: 'behind main' })).toBeDefined()
    expect(await ui.find({ text: /^\+120 −30 · 4 files/ })).toBeDefined()

    await ui.press({ key: 'ask-ci:https://github.com/acme/app/pull/1' })
    await ui.unmount()
  }

  expect(seen.prompts.length).toBe(2)
  expect(seen.prompts[0]).toContain('acme/app#1')
  expect(seen.prompts[0]).toContain('unit tests')
})

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'pr-watch',
    surface,
    component: 'Pane',
    requestId: 'pr-watch',
    props: PANE_PROPS,
  })

test('a conflicting PR of mine gets one Ask Claude that leaves the fix to Claude', async ($, on) => {
  const clock = mock.clock(on)
  const URL = 'https://github.com/acme/app/pull/1'
  let role: 'mine' | 'review' = 'mine'
  const seen = world(on, { cwd: '/code/app' }, () =>
    answer(PENDING, 'acme/app', { mergeable: 'CONFLICTING', role }),
  )

  await $.session.start(START)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: '⚠ conflicts with main' })).toBeDefined()
    expect(await ui.find({ key: `ask-update:${URL}` })).toBeDefined()
    // CI is only running, so there is no CI button.
    expect(await ui.find({ key: `ask-ci:${URL}` })).toBeUndefined()

    await ui.press({ key: `ask-update:${URL}` })
    await ui.unmount()
  }

  expect(seen.prompts.length).toBe(2)
  expect(seen.prompts[0]).toContain('has merge conflicts with `main`')
  expect(seen.prompts[0]).toContain('decide the best way to fix it')
  expect(seen.toasts.at(-1)).toBe(
    'Asked Claude to fix the merge conflicts on app#1; it starts once the session is idle',
  )

  role = 'review'
  await clock.advance(120_000)
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /Review requested \(1\)/ })).toBeDefined()
  expect(await ui.find({ key: `ask-update:${URL}` })).toBeUndefined()
  await ui.unmount()
})

test('a PR of mine that is behind main gets the same Ask Claude', async ($, on) => {
  const clock = mock.clock(on)
  const URL = 'https://github.com/acme/app/pull/1'
  // The fixture PR merges cleanly and GitHub reports it BEHIND.
  const seen = world(on, { cwd: '/code/app' }, () => answer(PENDING))

  await $.session.start(START)
  await clock.settle()

  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ text: 'behind main' })).toBeDefined()
  await ui.press({ key: `ask-update:${URL}` })
  await ui.unmount()

  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('is behind `main`')
  expect(seen.prompts[0]).toContain('gh pr update-branch 1 --repo acme/app')
  expect(seen.toasts.at(-1)).toBe(
    'Asked Claude to bring it up to date with main on app#1; it starts once the session is idle',
  )
})
