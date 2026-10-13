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

test('the real V8 endpoint clock matches an independently running Node CPU profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cpu-clock-'))
  roots.push(root)
  const clockModule = new URL('../dsh/electron-host/cpu-profile-clock.js', import.meta.url).href
  const { stdout } = await execute(process.execPath, [
    '--cpu-prof',
    `--cpu-prof-dir=${root}`,
    '--input-type=module',
    '-e',
    `import { captureCpuProfileEndpoint } from ${JSON.stringify(clockModule)};
     console.log(captureCpuProfileEndpoint());
     await new Promise(resolve => setTimeout(resolve, 30));`,
  ])
  const files = await import('node:fs/promises').then(fs => fs.readdir(root))
  const profile = JSON.parse(
    await readFile(
      join(
        root,
        files.find(name => name.endsWith('.cpuprofile'))
      )
    )
  )
  const endpoint = Number(stdout.trim())
  expect(endpoint).toBeGreaterThan(profile.startTime)
  expect(endpoint).toBeLessThan(profile.endTime)
  expect(profile.endTime - endpoint).toBeGreaterThan(20000)
  expect(summarizeCoreCpuProfile(profile, endpoint).scope).toBe('startup-to-endpoint')
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
