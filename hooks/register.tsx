import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { CiState, MergeMethod, Pr, Snapshot } from '../types'
import { ciLine, mergeLine, reviewLine, sizeLine } from './details'
import type { Line } from './details'
import { CI_ICON, changes, ref, settle, summary, toastText } from './diff'
import { GH_CANDIDATES, ghArgs, parsePrs, parseRemote, reasonOf } from './github'
import type { FetchResult } from './github'
import { canMerge, mergeArgs, mergeFailure, mergeLabel } from './merge'
import { ciPrompt, stalenessOf, updatePrompt } from './prompts'

const PANE = 'pr-watch'
const snapshot = atom({ plugin: 'pr-watch', key: 'latest' } as const, null)
const confirming = atom({ plugin: 'pr-watch', key: 'confirming' } as const, null)
const merging = atom({ plugin: 'pr-watch', key: 'merging' } as const, null)

const CI_COLOR: Record<CiState, Color> = {
  success: 'success',
  failure: 'error',
  pending: 'warning',
  none: 'subtle',
}

// CI, review and merge state have their own lines; the header keeps who and what kind.
const tagsOf = (p: Pr): { text: string; color: Color }[] => [
  ...(p.isDraft ? [{ text: 'draft', color: 'subtle' }] : []),
  ...(p.role === 'review' ? [{ text: `by ${p.author}`, color: 'subtle' }] : []),
]

const hhmm = (ms: number): string => {
  const at = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

// Module state starts over on every reload; the snapshot itself lives in $.state.
let pollSeconds = 120
let isPolling = false
let isPollWanted = false
let ghPath: string | undefined
let repoOf: { cwd: string; repo: string | null } | undefined
// PRs merged from the pane: their "closed or merged" toast would only repeat "Merged".
const mergedHere = new Set<string>()

/** The session folder's github.com repo (`owner/name`), or null; asks git once per folder. */
async function sessionRepo($: EngineInterface): Promise<string | null> {
  const cwd = await $.session.cwd()
  if (repoOf?.cwd === cwd) return repoOf.repo

  let repo: string | null = null
  try {
    const ran = await $.process.run(['git', 'remote', 'get-url', 'origin'], {
      cwd,
      timeoutMs: 5_000,
    })
    repo = ran.exitCode === 0 ? parseRemote(ran.stdout) : null
  } catch {
    repo = null // no git here, or the folder is gone
  }
  repoOf = { cwd, repo }

  return repo
}

type GhRun =
  | { ok: true; exitCode: number; stdout: string; stderr: string }
  | { ok: false; error: string }

/** Runs the person's `gh` with `args`, finding it on first use. */
async function runGh($: EngineInterface, args: readonly string[]): Promise<GhRun> {
  for (const gh of ghPath === undefined ? GH_CANDIDATES : [ghPath]) {
    let ran
    try {
      ran = await $.process.run([gh, ...args], { timeoutMs: 30_000 })
    } catch (err) {
      if (/timed? ?out|still running/i.test(String(err)))
        return { ok: false, error: 'gh timed out' }
      continue // not installed here; try the next place
    }
    ghPath = gh

    return { ok: true, exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }
  }
  ghPath = undefined

  return { ok: false, error: 'gh not found' }
}

/** Runs the repo's PR query. */
async function fetchPrs($: EngineInterface, repo: string): Promise<FetchResult> {
  const ran = await runGh($, ghArgs(repo))
  if (!ran.ok) return ran
  if (ran.exitCode !== 0) return { ok: false, error: reasonOf(ran.stderr) }

  return parsePrs(ran.stdout)
}

/** One poll: find the repo, fetch, toast what changed since the last good poll, store, show. */
async function pollOnce($: EngineInterface): Promise<void> {
  const repo = await sessionRepo($)
  if (repo === null) {
    await update($, snapshot, () => ({
      repo: null,
      mergeMethod: null,
      prs: [],
      fetchedAt: null,
      error: null,
    }))
    $.ui.status(undefined)
    return
  }

  // Another repo's PRs are no baseline: a switch starts over without toasts.
  const stored = await read($, snapshot)
  const prev = stored?.repo === repo ? stored : null
  const result = await fetchPrs($, repo)

  if (!result.ok) {
    const failed: Snapshot = {
      repo,
      mergeMethod: prev?.mergeMethod ?? null,
      prs: prev?.prs ?? [],
      fetchedAt: prev?.fetchedAt ?? null,
      error: result.error,
    }
    await update($, snapshot, () => failed)
    $.ui.status(summary(failed))
    return
  }

  const prs = settle(prev?.prs, result.prs)
  // The first good poll is the baseline: nothing is new to the person yet.
  if (prev !== null && prev.fetchedAt !== null) {
    const found = changes(prev.prs, prs).filter(
      c => !(c.what === 'closed or merged' && mergedHere.has(c.pr.url)),
    )
    const text = toastText(found)
    if (text !== undefined) $.ui.toast(text, { timeoutMs: 10_000 })
  }

  mergedHere.clear()
  const fresh: Snapshot = {
    repo,
    mergeMethod: result.mergeMethod,
    prs,
    fetchedAt: await $.clock.now(),
    error: null,
  }
  await update($, snapshot, () => fresh)
  $.ui.status(summary(fresh))
}

/** Polls now; a call while one runs is folded into one more run after it. */
async function poll($: EngineInterface): Promise<void> {
  if (isPolling) {
    isPollWanted = true
    return
  }
  isPolling = true
  try {
    do {
      isPollWanted = false
      await pollOnce($)
    } while (isPollWanted)
  } catch (err) {
    $.ui.status(`PRs ⚠ ${String(err).slice(0, 80)}`)
  } finally {
    isPolling = false
  }
}

/** Queues `text` as the person's own prompt; `what` names the ask in the toast. */
function askClaude($: EngineInterface, p: Pr, text: string, what: string): void {
  void $.prompt
    .submit({ text, asUser: true })
    .catch(() => $.ui.toast(`pr-watch: could not queue the prompt for ${ref(p)}`))
  $.ui.toast(`Asked Claude to ${what} on ${ref(p)}; it starts once the session is idle`)
}

/** Merges `p` as the pane showed it (Confirm was pressed), says how it went, and refreshes. */
async function mergePr($: EngineInterface, p: Pr, method: MergeMethod): Promise<void> {
  if ((await read($, merging)) !== null) return
  await update($, confirming, () => null)
  await update($, merging, () => p.url)

  let said: string
  try {
    const ran = await runGh($, mergeArgs(p, method))
    if (!ran.ok) said = `Could not merge ${ref(p)}: ${ran.error}`
    else if (ran.exitCode !== 0) said = `Could not merge ${ref(p)}: ${mergeFailure(ran.stderr)}`
    else {
      mergedHere.add(p.url)
      said = `Merged ${ref(p)} into ${p.baseBranch || 'main'}`
    }
  } finally {
    await update($, merging, () => null)
  }
  $.ui.toast(said, { timeoutMs: 10_000 })
  await poll($)
}

export const register: Register = (on, options) => {
  pollSeconds = Math.max(30, Number(options.pollSeconds ?? 120) || 120)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description: "Show your open PRs and review requests in this session's GitHub repo",
    })

    // After a hot reload the session's last snapshot is still there.
    const prev = await read($, snapshot)
    if (prev !== null) $.ui.status(summary(prev))

    void poll($)
    $.clock.every(pollSeconds * 1000, () => void poll($))

    return next(e)
  })

  // The session moved to another folder, maybe another repo: look again now.
  on('classic.CwdChanged', ($, e, next) => {
    void poll($)

    return next(e)
  })

  // Opens the pane and says nothing in the transcript.
  on('command.run', { command: 'prs' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Pull requests' })
    if (!opened.isPlaced) $.ui.toast('pr-watch: the PR pane opens once the window has room')
    void poll($)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)

    if (snap === null) return <Text dimColor>Checking GitHub…</Text>
    if (snap.repo === null) {
      return (
        <Text dimColor>
          This session's folder is not a GitHub repo (no github.com origin remote), so there are no
          PRs to show.
        </Text>
      )
    }

    const confirmingUrl = await read($, confirming)
    const mergingUrl = await read($, merging)
    const method = snap.mergeMethod ?? null
    const mine = snap.prs.filter(p => p.role === 'mine')
    const asked = snap.prs.filter(p => p.role === 'review')
    const now = snap.fetchedAt ?? 0

    const detail = (label: string, line: Line) => (
      <Box flexDirection="row" paddingLeft={2}>
        <Box width={8} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text color={line.color ?? 'text'}>{line.text}</Text>
      </Box>
    )

    const row = (p: Pr) => {
      const stale = p.role === 'mine' ? stalenessOf(p) : undefined
      const mergeWith = method !== null && canMerge(p) ? method : null
      const isConfirming = mergeWith !== null && confirmingUrl === p.url && mergingUrl !== p.url

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={CI_COLOR[p.ci]}>{CI_ICON[p.ci]}</Text>
            <Link href={p.url} label={`#${p.number}`} />
            {tagsOf(p).map(tag => (
              <Text color={tag.color}>{tag.text}</Text>
            ))}
          </Box>
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {p.title}
            </Text>
          </Box>
          {detail('CI', ciLine(p))}
          {p.role === 'mine' && p.ci === 'failure' && (
            <Box paddingLeft={10}>
              <Button
                key={`ask-ci:${p.url}`}
                label="Ask Claude"
                onPress={() => askClaude($, p, ciPrompt(p), 'look into failing CI')}
              />
            </Box>
          )}
          {detail('Review', reviewLine(p))}
          {detail('Merge', mergeLine(p))}
          {(stale !== undefined || mergeWith !== null) && (
            <Box paddingLeft={10} flexDirection="row" gap={1} flexWrap="wrap">
              {stale !== undefined && (
                <Button
                  key={`ask-update:${p.url}`}
                  label="Ask Claude"
                  onPress={() =>
                    askClaude(
                      $,
                      p,
                      updatePrompt(p, stale),
                      stale === 'conflict'
                        ? 'fix the merge conflicts'
                        : `bring it up to date with ${p.baseBranch || 'main'}`,
                    )
                  }
                />
              )}
              {mergeWith !== null && mergingUrl === p.url && <Text color="warning">Merging…</Text>}
              {mergeWith !== null && mergingUrl !== p.url && !isConfirming && (
                <Button
                  key={`merge:${p.url}`}
                  label={mergeLabel(mergeWith)}
                  onPress={() => update($, confirming, () => p.url)}
                />
              )}
            </Box>
          )}
          {mergeWith !== null && isConfirming && (
            <Box paddingLeft={10} flexDirection="row" gap={1} flexWrap="wrap">
              <Text color="warning">
                {`${mergeLabel(mergeWith)} #${p.number} into ${p.baseBranch || 'main'}?`}
              </Text>
              <Button
                key={`merge-confirm:${p.url}`}
                label="Confirm"
                variant="primary"
                onPress={() => mergePr($, p, mergeWith)}
              />
              <Button
                key={`merge-cancel:${p.url}`}
                label="Cancel"
                onPress={() => update($, confirming, () => null)}
              />
            </Box>
          )}
          {detail('Size', sizeLine(p, now))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor wrap="truncate-end">
            {snap.repo} ·{' '}
            {snap.fetchedAt === null ? 'not loaded yet' : `updated ${hhmm(snap.fetchedAt)}`} · every{' '}
            {pollSeconds}s
          </Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => poll($)} />
        </Box>
        {snap.error !== null && <Text color="error">⚠ {snap.error}</Text>}
        <Text bold>Your PRs ({mine.length})</Text>
        {mine.length === 0 ? <Text dimColor>None open.</Text> : mine.map(row)}
        <Text bold>Review requested ({asked.length})</Text>
        {asked.length === 0 ? <Text dimColor>Nothing waiting on you.</Text> : asked.map(row)}
      </Box>
    )
  })
}
