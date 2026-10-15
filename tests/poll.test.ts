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
const PASSING: Rollup = {
  state: 'SUCCESS',
  contexts: {
    checkRunCountsByState: [{ state: 'SUCCESS', count: 4 }],
    statusContextCountsByState: [],
    nodes: [{ __typename: 'CheckRun', name: 'unit tests', conclusion: 'SUCCESS' }],
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

type Over = { mergeable?: string; role?: 'mine' | 'review'; none?: boolean }

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
    headRefOid: 'abc123',
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
  const nodes = over.none === true ? [] : [node]

  return {
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      data: {
        repo: { viewerDefaultMergeMethod: 'SQUASH' },
        mine: { nodes: isMine ? nodes : [] },
        review: { nodes: isMine ? [] : nodes },
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
 * REMOTES, a fake `gh`, a fake `open` (exiting `openExit`), and a record of
 * what the plugin showed and ran.
 */
const world = (
  on: On,
  folder: { cwd: string },
  gh: (argv: readonly string[]) => Ran,
  openExit = 0,
) => {
  const seen = {
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    prompts: [] as string[],
    ghCalls: [] as string[][],
    /** Each link handed to `open`, parsed. */
    opens: [] as URL[],
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: folder.cwd }))
  on('classic.CwdChanged', () => ({}))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const [command, ...args] = e.argv
    let ran: Ran
    if (command === '/usr/bin/open') {
      seen.opens.push(new URL(args[0] ?? ''))
      ran = { exitCode: openExit, stdout: '', stderr: openExit === 0 ? '' : 'no handler' }
    } else if (command === 'git') {
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

  // The terminal asks in this conversation.
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('acme/app#1')
  expect(seen.prompts[0]).toContain('unit tests')
  // The desktop app opens a new session on the same folder, with the same prompt.
  expect(seen.opens.length).toBe(1)
  expect(seen.opens[0]?.href.startsWith('claude://code/new?')).toBe(true)
  expect(seen.opens[0]?.searchParams.get('folder')).toBe('/code/app')
  expect(seen.opens[0]?.searchParams.get('q')).toBe(seen.prompts[0])
  expect(seen.toasts.at(-1)).toBe(
    'Opened a new session to look into failing CI on app#1; send the prompt there to start',
  )
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

  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('has merge conflicts with `main`')
  expect(seen.prompts[0]).toContain('decide the best way to fix it')
  expect(seen.opens.map(u => u.searchParams.get('q'))).toEqual([seen.prompts[0]])
  expect(seen.toasts.at(-1)).toBe(
    'Opened a new session to fix the merge conflicts on app#1; send the prompt there to start',
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

  // On the desktop: a new session, nothing asked in this conversation.
  expect(seen.prompts).toEqual([])
  const q = seen.opens[0]?.searchParams.get('q') ?? ''
  expect(q).toContain('is behind `main`')
  expect(q).toContain('gh pr update-branch 1 --repo acme/app')
  expect(seen.toasts.at(-1)).toBe(
    'Opened a new session to bring it up to date with main on app#1; send the prompt there to start',
  )
})

test('if the desktop app cannot be opened, Ask Claude asks in this conversation', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { cwd: '/code/app' }, () => answer(FAILING), 1)

  await $.session.start(START)
  await clock.settle()

  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'ask-ci:https://github.com/acme/app/pull/1' })
  await ui.unmount()

  expect(seen.opens.length).toBe(1)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('unit tests')
  expect(seen.toasts.at(-1)).toBe(
    'Asked Claude to look into failing CI on app#1; it starts once the session is idle',
  )
})

test('an approved PR of mine merges only after Confirm, pinned to the head it showed', async ($, on) => {
  const clock = mock.clock(on)
  const URL = 'https://github.com/acme/app/pull/1'
  const merges: string[][] = []
  const seen = world(on, { cwd: '/code/app' }, args => {
    if (args[0] === 'pr') {
      merges.push([...args])
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    // Once merged, the PR is no longer open.
    return answer(PASSING, 'acme/app', { none: merges.length > 0 })
  })

  await $.session.start(START)
  await clock.settle()

  const ui = await mountPane($, 'desktop')
  // Approved, CI green, behind main: the merge button beside Ask Claude.
  expect(await ui.find({ key: `ask-update:${URL}` })).toBeDefined()
  expect(await ui.find({ key: `merge:${URL}` })).toBeDefined()
  expect(await ui.find({ text: 'Squash and merge' })).toBeDefined()

  // The first press only asks.
  await ui.press({ key: `merge:${URL}` })
  expect(await ui.find({ text: 'Squash and merge #1 into main?' })).toBeDefined()
  expect(await ui.find({ key: `merge:${URL}` })).toBeUndefined()
  expect(merges).toEqual([])

  // Cancel goes back.
  await ui.press({ key: `merge-cancel:${URL}` })
  expect(await ui.find({ key: `merge-confirm:${URL}` })).toBeUndefined()
  expect(await ui.find({ key: `merge:${URL}` })).toBeDefined()
  expect(merges).toEqual([])

  // Confirm merges, by repo, pinned to the head commit.
  await ui.press({ key: `merge:${URL}` })
  await ui.press({ key: `merge-confirm:${URL}` })
  expect(merges).toEqual([
    ['pr', 'merge', '1', '--repo', 'acme/app', '--squash', '--match-head-commit', 'abc123'],
  ])
  expect(seen.toasts).toContain('Merged app#1 into main')
  // The refresh sees it gone, and does not toast "closed or merged" on top.
  expect(seen.toasts.filter(t => t.includes('closed or merged'))).toEqual([])
  expect(seen.statuses.at(-1)).toBe('app · PRs: none open')
  await ui.unmount()
})

test('a refused merge says why and leaves the PR as it was', async ($, on) => {
  const clock = mock.clock(on)
  const URL = 'https://github.com/acme/app/pull/1'
  const seen = world(on, { cwd: '/code/app' }, args =>
    args[0] === 'pr'
      ? {
          exitCode: 1,
          stdout: '',
          stderr:
            'X Pull request acme/app#1 is not mergeable: the base branch policy prohibits the merge.\n',
        }
      : answer(PASSING),
  )

  await $.session.start(START)
  await clock.settle()

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: `merge:${URL}` })
  await ui.press({ key: `merge-confirm:${URL}` })
  expect(seen.toasts.at(-1)).toBe(
    'Could not merge app#1: Pull request acme/app#1 is not mergeable: the base branch policy prohibits the merge.',
  )
  expect(await ui.find({ text: /Your PRs \(1\)/ })).toBeDefined()
  expect(await ui.find({ key: `merge:${URL}` })).toBeDefined()
  await ui.unmount()
})

test('no merge button on a review request, even an approved one', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { cwd: '/code/app' }, () => answer(PASSING, 'acme/app', { role: 'review' }))

  await $.session.start(START)
  await clock.settle()

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /Review requested \(1\)/ })).toBeDefined()
  expect(await ui.find({ key: 'merge:https://github.com/acme/app/pull/1' })).toBeUndefined()
  await ui.unmount()
})
