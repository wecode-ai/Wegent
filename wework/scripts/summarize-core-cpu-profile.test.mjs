import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { summarizeCoreCpuProfile } from './summarize-core-cpu-profile.mjs'

const roots = []
const execute = promisify(execFile)
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function fixture() {
  return {
    startTime: 1000,
    endTime: 13000,
    nodes: [
      { id: 1, children: [2, 4], callFrame: { functionName: '(root)', url: '' } },
      {
        id: 2,
        children: [3],
        callFrame: {
          functionName: 'createRuntimeResolution',
          url: 'file:///private/user/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
        },
      },
      { id: 3, callFrame: { functionName: 'readFileUtf8', url: '' } },
      {
        id: 4,
        callFrame: {
          functionName: 'private-token-function',
          url: 'file:///private/user/auth/private-token.js?secret=private-token',
        },
      },
    ],
    samples: [3, 3, 4],
    timeDeltas: [1000, 2000, 8000],
  }
}

test('aggregates known boot ancestry while excluding paths and arbitrary function names', () => {
  const summary = summarizeCoreCpuProfile(fixture())
  expect(summary.bootOperations).toEqual([
    { name: 'createRuntimeResolution', samples: 2, sampledMs: 3 },
  ])
  expect(summary.modules).toEqual([
    { name: 'other', samples: 1, sampledMs: 8 },
    { name: 'native:readFileUtf8', samples: 2, sampledMs: 3 },
  ])
  expect(JSON.stringify(summary)).not.toMatch(/private-token|private\/user|secret=|file:\/\//)
  expect(() => summarizeCoreCpuProfile({ ...fixture(), timeDeltas: [-1, 2, 3] })).toThrow(
    'Invalid CPU profile'
  )
})

test('retains safe summaries while the real CI diagnostics pruner removes raw profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cpu-profile-private-'))
  roots.push(root)
  const logs = join(root, 'session/electron-user-data/logs')
  const privateRoot = join(root, 'session/electron-user-data/dsh-core/.cpu-profile')
  await mkdir(logs, { recursive: true })
  await mkdir(privateRoot, { recursive: true })
  const raw = join(privateRoot, 'CPU.cpuprofile')
  await writeFile(raw, JSON.stringify(fixture()))
  const { stdout } = await execute(process.execPath, [
    resolve('scripts/summarize-core-cpu-profile.mjs'),
    raw,
  ])
  const summaryPath = join(logs, 'core-cpu-summary.json')
  await writeFile(summaryPath, stdout)
  await execute('bash', [
    resolve('../.github/scripts/prune-wework-desktop-e2e-diagnostics.sh'),
    root,
  ])
  await expect(readFile(raw)).rejects.toMatchObject({ code: 'ENOENT' })
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
  expect(summary.samples).toBe(3)
  expect(JSON.stringify(summary)).not.toContain('private-token')
})
