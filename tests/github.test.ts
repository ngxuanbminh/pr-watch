import { describe, expect, test } from 'claude-code/testing'

import { ghArgs, parseRemote } from '../hooks/github'

describe('parseRemote', () => {
  test('reads https, scp-style ssh and ssh URLs', () => {
    expect(parseRemote('https://github.com/acme/rocket.git\n')).toBe('acme/rocket')
    expect(parseRemote('https://github.com/acme/launchpad')).toBe('acme/launchpad')
    expect(parseRemote('git@github.com:acme/rocket.git')).toBe('acme/rocket')
    expect(parseRemote('ssh://git@github.com/acme/app.js.git')).toBe('acme/app.js')
  })

  test('answers null for other hosts and for no repo', () => {
    expect(parseRemote('https://gitlab.com/acme/app.git')).toBeNull()
    expect(parseRemote('')).toBeNull()
  })
})

describe('ghArgs', () => {
  test('holds both searches to the repo', () => {
    const args = ghArgs('acme/app')
    expect(args).toContain('mine=is:open is:pr archived:false author:@me repo:acme/app')
    expect(args).toContain('review=is:open is:pr archived:false review-requested:@me repo:acme/app')
  })
})
