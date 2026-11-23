import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { resolveRealNodeExecutable } from './real-node-executable.mjs'

// Stubs are POSIX shell scripts; the Windows host contamination this covers
// does not exist (the Electron-helper shim is a macOS artifact).
const describePosix = process.platform === 'win32' ? test.skip : test

let root

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'real-node-executable-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function stubNode(directory, script) {
  await mkdir(directory, { recursive: true })
  const candidate = join(directory, 'node')
  await writeFile(candidate, script)
  await chmod(candidate, 0o755)
  return candidate
}

describePosix('returns the executable reported by Node, not the PATH shim', async () => {
  const electronDir = join(root, 'electron')
  const shimDir = join(root, 'shim')
  const real = join(root, 'real', 'node')
  await stubNode(electronDir, '#!/bin/sh\necho \'["43.0.0", "24.0.0", "helper", "strip"]\'')
  await stubNode(
    shimDir,
    '#!/bin/sh\necho \'["", "26.0.0", ' + JSON.stringify(real) + ', "strip"]\''
  )
  const resolved = await resolveRealNodeExecutable({
    pathValue: [electronDir, shimDir].join(delimiter),
    fallbackDirectories: [],
  })
  expect(resolved).toEqual({ executable: real, nodeVersion: '26.0.0' })
})

describePosix('rejects a candidate that cannot run unflagged TypeScript', async () => {
  const directory = join(root, 'without-typescript')
  await stubNode(directory, '#!/bin/sh\necho \'["", "22.15.0", "node", ""]\'')
  await expect(
    resolveRealNodeExecutable({ pathValue: directory, fallbackDirectories: [] })
  ).rejects.toThrow('real Node.js executable is required')
})

describePosix('fails with a descriptive error when no real Node.js exists', async () => {
  const electronDir = join(root, 'electron')
  await stubNode(electronDir, '#!/bin/sh\necho \'["43.0.0", "24.0.0", "helper", "strip"]\'')
  await expect(
    resolveRealNodeExecutable({ pathValue: electronDir, fallbackDirectories: [] })
  ).rejects.toThrow('real Node.js executable is required')
})
