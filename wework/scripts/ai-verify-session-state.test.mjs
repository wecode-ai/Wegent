// @vitest-environment node
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, copyFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { updateSessionState } from './ai-verify-session-state.mjs'
import {
  captureSessionAuthOwnership,
  cleanupSessionAuth,
  observeSessionAuthOwnership,
} from './ai-verify-auth-cleanup.mjs'
import { writeManagedAuthMarker } from '../electron/src/runtime/managed-auth-marker.ts'

test('persists native ownership cleanup across concurrent controller and stale CLI transactions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-session-auth-'))
  try {
    const native = join(directory, 'native')
    const managed = join(directory, 'executor-home', 'codex')
    await mkdir(native, { recursive: true })
    await mkdir(managed, { recursive: true })
    const source = join(native, 'auth.json')
    const target = join(managed, 'auth.json')
    await writeFile(source, 'synthetic-source')
    const session = { directory }
    session.authCleanup = await captureSessionAuthOwnership(session, { nativeCodexHome: native })
    const path = join(directory, 'session.json')
    await writeFile(path, JSON.stringify(session))
    if (process.platform === 'win32') await copyFile(source, target)
    else await symlink(source, target)
    writeManagedAuthMarker(managed, session.authCleanup.ownerId)
    await Promise.all([
      updateSessionState(path, observeSessionAuthOwnership),
      updateSessionState(path, cleanupSessionAuth, session),
    ])
    await updateSessionState(path, observeSessionAuthOwnership, session)
    const latest = JSON.parse(await readFile(path, 'utf8'))
    expect(latest.authCleanup.cleaned).toBe(true)
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source, 'utf8')).toBe('synthetic-source')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('serializes observer, cleanup and stale CLI writers without reverting cleaned state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-session-state-'))
  try {
    const path = join(directory, 'session.json')
    const stale = { authCleanup: { cleaned: false }, launcherPid: null }
    await writeFile(path, JSON.stringify(stale))
    let releaseObserver
    let markEntered
    const entered = new Promise(resolve => {
      markEntered = resolve
    })
    const gate = new Promise(resolve => {
      releaseObserver = resolve
    })
    const observer = updateSessionState(path, async latest => {
      markEntered()
      await gate
      latest.observed = true
    })
    await entered
    const cleanup = updateSessionState(path, latest => {
      latest.authCleanup.cleaned = true
    })
    releaseObserver()
    await Promise.all([observer, cleanup])
    await updateSessionState(
      path,
      latest => {
        latest.launcherPid = 123
      },
      stale
    )
    await updateSessionState(
      path,
      latest => {
        expect(latest.authCleanup.cleaned).toBe(true)
        latest.lastObserved = true
      },
      stale
    )
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      authCleanup: { cleaned: true },
      launcherPid: 123,
      observed: true,
      lastObserved: true,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
