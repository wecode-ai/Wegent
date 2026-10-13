import { once } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  const raw = join(privateRoot, 'CPU.20261013.120000.10.0.001.cpuprofile')
  await writeFile(raw, JSON.stringify(fixture()))
  await writeFile(
    join(logs, 'dsh-core-runtime.log'),
    '[startup][core-dsh-endpoint] { elapsedMs: 4, cpuProfileEndTimeUs: 5000, cpuProfileProcessId: 10 }'
  )
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
  const startup = JSON.parse(await readFile(join(logs, 'core-startup-cpu-summary-1.json'), 'utf8'))
  expect(startup.scope).toBe('startup-to-endpoint')
  expect(startup.modules).toEqual([
    { name: 'native:readFileUtf8', samples: 2, sampledMs: 3 },
    { name: 'other', samples: 1, sampledMs: 1 },
  ])
  expect(JSON.stringify(startup)).not.toMatch(/private-token|private\/user|secret=|file:\/\//)
})

test('clips the boundary interval and excludes all subsequent runtime samples', () => {
  const summary = summarizeCoreCpuProfile(fixture(), 3500)
  expect(summary.scope).toBe('startup-to-endpoint')
  expect(summary.durationMs).toBe(2.5)
  expect(summary.samples).toBe(2)
  expect(summary.modules).toEqual([{ name: 'native:readFileUtf8', samples: 2, sampledMs: 2.5 }])
  expect(summary.bootOperations).toEqual([
    { name: 'createRuntimeResolution', samples: 2, sampledMs: 2.5 },
  ])
  for (const marker of [NaN, 1000, 14000]) {
    expect(() => summarizeCoreCpuProfile(fixture(), marker)).toThrow(
      'Startup marker is outside CPU profile'
    )
  }
})

test('writes safe startup samples before forced termination of a preloaded real Node process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cpu-bootstrap-'))
  roots.push(root)
  const bootstrap = pathToFileURL(resolve('dsh/electron-host/cpu-profile-bootstrap.js')).href
  const dshHome = join(root, 'session/electron-user-data/dsh-core')
  const logsRoot = join(dshHome, '../logs')
  const child = spawn(
    process.execPath,
    [
      '--import',
      bootstrap,
      '--input-type=module',
      '-e',
      'let total=0;for(let i=0;i<20000000;i++)total+=Math.sqrt(i);console.log(JSON.stringify(globalThis[Symbol.for("wework.core.startupCpuProfiler")].complete()));setInterval(()=>{},1000);',
    ],
    { env: { ...process.env, WEWORK_E2E_CORE_CPU_PROFILE: '1', DSH_HOME: dshHome } }
  )
  const exited = once(child, 'exit')
  try {
    const output = await once(child.stdout, 'data')
    const marker = JSON.parse(String(output[0]))
    expect(marker.cpuProfileProcessId).toBe(child.pid)
    const summaryPath = join(logsRoot, 'core-startup-cpu-profile-' + child.pid + '.json')
    const before = await readFile(summaryPath, 'utf8')
    child.kill('SIGKILL')
    await exited
    expect(await readFile(summaryPath, 'utf8')).toBe(before)
    const summary = JSON.parse(before)
    expect(summary.scope).toBe('startup-to-endpoint')
    expect(summary.samples).toBeGreaterThan(0)
    expect(JSON.stringify(summary)).not.toContain(root)
    expect(summary).not.toHaveProperty('nodes')
    expect(summary).not.toHaveProperty('timeDeltas')
    await writeFile(
      join(logsRoot, 'dsh-core-runtime.log'),
      `[startup][core-dsh-endpoint] { cpuProfileEndTimeUs: ${marker.cpuProfileEndTimeUs}, cpuProfileProcessId: ${child.pid} }`
    )
    await execute('bash', [
      resolve('../.github/scripts/prune-wework-desktop-e2e-diagnostics.sh'),
      root,
    ])
    expect(await readFile(summaryPath, 'utf8')).toBe(before)
    expect(
      JSON.parse(await readFile(join(logsRoot, 'core-startup-cpu-profile-status.json'), 'utf8'))
    ).toEqual({
      completedProfiles: 1,
      endpointProcesses: 1,
      processesWithoutCompletedProfile: 0,
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
})

test('an unmatched clock fails diagnostics and still deletes every raw profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cpu-clock-invalid-'))
  roots.push(root)
  const logs = join(root, 'session/electron-user-data/logs')
  const privateRoot = join(root, 'session/electron-user-data/dsh-core/.cpu-profile')
  await mkdir(logs, { recursive: true })
  await mkdir(privateRoot, { recursive: true })
  const raw = join(privateRoot, 'CPU.20261013.120000.10.0.001.cpuprofile')
  await writeFile(raw, JSON.stringify(fixture()))
  await writeFile(
    join(logs, 'dsh-core-runtime.log'),
    '[startup][core-dsh-endpoint] { elapsedMs: 4 }'
  )
  await expect(
    execute('bash', [resolve('../.github/scripts/prune-wework-desktop-e2e-diagnostics.sh'), root])
  ).rejects.toMatchObject({ code: 1 })
  await expect(readFile(raw)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(logs, 'core-startup-cpu-summary-1.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test('maps overlapping restarted profiles by process and tolerates a killed process without raw output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cpu-clock-restarts-'))
  roots.push(root)
  const logs = join(root, 'session/electron-user-data/logs')
  const privateRoot = join(root, 'session/electron-user-data/dsh-core/.cpu-profile')
  await mkdir(logs, { recursive: true })
  await mkdir(privateRoot, { recursive: true })
  await writeFile(join(root, 'runner-metadata.json'), '{}')
  const rawProfiles = [10, 20].map(pid =>
    join(privateRoot, `CPU.20261013.120000.${pid}.0.001.cpuprofile`)
  )
  await Promise.all(rawProfiles.map(path => writeFile(path, JSON.stringify(fixture()))))
  await writeFile(
    join(logs, 'dsh-core-runtime.log'),
    [
      '[startup][core-dsh-endpoint] { cpuProfileEndTimeUs: 5000, cpuProfileProcessId: 10 }',
      '[startup][core-dsh-endpoint] { cpuProfileEndTimeUs: 3500, cpuProfileProcessId: 20 }',
      '[startup][core-dsh-endpoint] { cpuProfileEndTimeUs: 3500, cpuProfileProcessId: 30 }',
    ].join('\n')
  )
  await execute('bash', [
    resolve('../.github/scripts/prune-wework-desktop-e2e-diagnostics.sh'),
    root,
  ])
  for (const raw of rawProfiles)
    await expect(readFile(raw)).rejects.toMatchObject({ code: 'ENOENT' })
  const summaries = await Promise.all(
    [1, 2].map(async index =>
      JSON.parse(await readFile(join(logs, `core-startup-cpu-summary-${index}.json`), 'utf8'))
    )
  )
  expect(summaries.map(summary => summary.durationMs).sort()).toEqual([2.5, 4])
  expect(JSON.stringify(summaries)).not.toMatch(/private-token|private\/user|secret=|file:\/\//)
  expect(
    JSON.parse(await readFile(join(logs, 'core-startup-cpu-profile-status.json'), 'utf8'))
  ).toEqual({
    completedProfiles: 2,
    endpointProcesses: 3,
    processesWithoutCompletedProfile: 1,
  })
})
