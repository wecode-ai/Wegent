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

test.each([
  [JSON.stringify(fixture()), 'CPU profile startup marker is unavailable'],
  ['private-token-not-json', 'Diagnostic input is unavailable'],
])(
  'reports a safe failure and still prunes raw profiles (case %#)',
  async (rawContents, reason) => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cpu-profile-private-'))
    roots.push(root)
    const logs = join(root, 'session/electron-user-data/logs')
    const privateRoot = join(root, 'session/electron-user-data/dsh-core/.cpu-profile')
    await mkdir(logs, { recursive: true })
    await mkdir(privateRoot, { recursive: true })
    const raw = join(privateRoot, 'CPU.20261013.120000.10.0.001.cpuprofile')
    await writeFile(raw, rawContents)
    await writeFile(
      join(logs, 'dsh-core-runtime.log'),
      '[startup][core-dsh-endpoint] { cpuProfileEndTimeUs: 14000, cpuProfileProcessId: 10 }'
    )
    const result = await execute('bash', [
      resolve('../.github/scripts/prune-wework-desktop-e2e-diagnostics.sh'),
      root,
    ]).catch(error => error)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(reason)
    expect(result.stderr).not.toMatch(/private-token|private\/user|secret=|file:\/\//)
    await expect(readFile(raw)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

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

test('details known packages and builtins while preserving broad totals and safe loader ancestry', () => {
  const profile = {
    startTime: 1000,
    endTime: 9000,
    nodes: [
      {
        id: 1,
        children: [2, 3, 4, 5],
        callFrame: { url: 'node:internal/modules/esm/module_job', functionName: 'private-token' },
      },
      {
        id: 2,
        callFrame: {
          url: 'file:///private/token/node_modules/@deepseek-ai/cosmokit/lib/index.js',
          functionName: 'private-token',
        },
      },
      {
        id: 3,
        callFrame: {
          url: 'file:///private/token/managed-components/core-plugins/hash/wework-executor-runtime/index.js',
          functionName: 'private-token',
        },
      },
      { id: 4, callFrame: { url: 'node:internal/fs/utils', functionName: 'private-token' } },
      {
        id: 5,
        callFrame: {
          url: 'file:///private/token/node_modules/private-package/auth.js?secret=token',
          functionName: 'private-token',
        },
      },
    ],
    samples: [2, 3, 4, 5],
    timeDeltas: [1000, 2000, 3000, 1000],
  }
  const summary = summarizeCoreCpuProfile(profile, 7500)
  expect(summary.modules).toEqual([
    { name: 'other', samples: 3, sampledMs: 3.5 },
    { name: 'node-other', samples: 1, sampledMs: 3 },
  ])
  expect(summary.moduleDetails).toEqual([
    { name: 'node-fs', samples: 1, sampledMs: 3 },
    { name: '@wegent/dsh-executor-runtime', samples: 1, sampledMs: 2 },
    { name: '@deepseek-ai/cosmokit', samples: 1, sampledMs: 1 },
    { name: 'unattributed-installed-package', samples: 1, sampledMs: 0.5 },
  ])
  expect(summary.nearestLoaderAncestors).toEqual([
    { name: 'node-esm-loader', samples: 4, sampledMs: 6.5 },
  ])
  expect(JSON.stringify(summary)).not.toMatch(
    /private-token|private-package|secret=|private\/token|file:\/\//
  )
})

test('separates unattributed frame origins without exposing their functions or locations', () => {
  const profile = {
    startTime: 1000,
    endTime: 7000,
    nodes: [
      { id: 1, callFrame: { url: '', functionName: 'private-token' } },
      {
        id: 2,
        callFrame: {
          url: 'file:///private/token/node_modules/private-package/source.js?secret=token',
          functionName: 'private-token',
        },
      },
      {
        id: 3,
        callFrame: { url: 'D:\\private\\token\\source.js', functionName: 'private-token' },
      },
      {
        id: 4,
        callFrame: {
          url: 'https://private-token/source.js?secret=token',
          functionName: 'private-token',
        },
      },
      { id: 5, callFrame: { url: 'node:internal/private-token', functionName: 'private-token' } },
      { id: 6, callFrame: { url: '', functionName: 'readFileUtf8' } },
    ],
    samples: [1, 2, 3, 4, 5, 6],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000],
  }
  const summary = summarizeCoreCpuProfile(profile, 7000)
  expect(summary.modules).toEqual([
    { name: 'other', samples: 4, sampledMs: 4 },
    { name: 'node-other', samples: 1, sampledMs: 1 },
    { name: 'native:readFileUtf8', samples: 1, sampledMs: 1 },
  ])
  expect(summary.moduleDetails).toEqual([
    { name: 'unattributed-empty-url', samples: 1, sampledMs: 1 },
    { name: 'unattributed-installed-package', samples: 1, sampledMs: 1 },
    { name: 'unattributed-file-module', samples: 1, sampledMs: 1 },
    { name: 'unattributed-script', samples: 1, sampledMs: 1 },
    { name: 'node-other', samples: 1, sampledMs: 1 },
    { name: 'native:readFileUtf8', samples: 1, sampledMs: 1 },
  ])
  expect(summary.moduleDetails.reduce((total, row) => total + row.sampledMs, 0)).toBe(6)
  expect(JSON.stringify(summary)).not.toMatch(
    /private-token|private-package|secret=|private\/token|file:|https:/
  )
  expect(summary).not.toHaveProperty('nodes')
  expect(summary).not.toHaveProperty('timeDeltas')
})

test('categorizes a real Node file module without retaining its private source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cpu-private-source-'))
  roots.push(root)
  const entry = join(root, 'private-token.mjs')
  const dshHome = join(root, 'session/dsh-core')
  await writeFile(
    entry,
    'let total=0;for(let i=0;i<20000000;i++)total+=Math.sqrt(i);console.log(JSON.stringify(await globalThis[Symbol.for("wework.core.startupCpuProfiler")].complete()))'
  )
  const { stdout } = await execute(
    process.execPath,
    ['--import', pathToFileURL(resolve('dsh/electron-host/cpu-profile-bootstrap.js')).href, entry],
    { env: { ...process.env, WEWORK_E2E_CORE_CPU_PROFILE: '1', DSH_HOME: dshHome } }
  )
  const marker = JSON.parse(stdout)
  const summary = JSON.parse(
    await readFile(
      join(dshHome, '../logs', `core-startup-cpu-profile-${marker.cpuProfileProcessId}.json`),
      'utf8'
    )
  )
  expect(
    summary.moduleDetails.find(row => row.name === 'unattributed-file-module')?.samples
  ).toBeGreaterThan(0)
  expect(JSON.stringify(summary)).not.toMatch(/private-token|file:/)
  expect(JSON.stringify(summary)).not.toContain(root)
  expect(summary).not.toHaveProperty('nodes')
})

test('waits for an asynchronous real inspector stop callback before publishing the startup marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cpu-delayed-stop-'))
  roots.push(root)
  const delayedInspector = join(root, 'delayed-inspector.mjs')
  await writeFile(
    delayedInspector,
    `import { Session } from 'node:inspector'
const original = Session.prototype.post
Session.prototype.post = function (method, ...args) {
  if (method !== 'Profiler.stop') return original.call(this, method, ...args)
  const callback = args.pop()
  return original.call(this, method, ...args, (error, result) => setImmediate(() => callback(error, result)))
}`
  )
  const dshHome = join(root, 'session/electron-user-data/dsh-core')
  const { stdout } = await execute(
    process.execPath,
    [
      '--import',
      pathToFileURL(delayedInspector).href,
      '--import',
      pathToFileURL(resolve('dsh/electron-host/cpu-profile-bootstrap.js')).href,
      '--input-type=module',
      '-e',
      'for(let i=0;i<1000000;i++)Math.sqrt(i);console.log(JSON.stringify(await globalThis[Symbol.for("wework.core.startupCpuProfiler")].complete()))',
    ],
    { env: { ...process.env, WEWORK_E2E_CORE_CPU_PROFILE: '1', DSH_HOME: dshHome } }
  )
  const marker = JSON.parse(stdout)
  const summary = JSON.parse(
    await readFile(
      join(dshHome, '../logs', 'core-startup-cpu-profile-' + marker.cpuProfileProcessId + '.json'),
      'utf8'
    )
  )
  expect(marker.cpuProfileSummaryMode).toBe('before-endpoint')
  expect(summary.scope).toBe('startup-to-endpoint')
  expect(summary.samples).toBeGreaterThan(0)
  expect(JSON.stringify(summary)).not.toContain(root)
  expect(summary).not.toHaveProperty('nodes')
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
      'let total=0;for(let i=0;i<20000000;i++)total+=Math.sqrt(i);console.log(JSON.stringify(await globalThis[Symbol.for("wework.core.startupCpuProfiler")].complete()));setInterval(()=>{},1000);',
    ],
    { env: { ...process.env, WEWORK_E2E_CORE_CPU_PROFILE: '1', DSH_HOME: dshHome } }
  )
  const exited = once(child, 'exit')
  try {
    const output = await once(child.stdout, 'data')
    const marker = JSON.parse(String(output[0]))
    expect(marker.cpuProfileProcessId).toBe(child.pid)
    expect(marker.cpuProfileSummaryMode).toBe('before-endpoint')
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
      `[startup][core-dsh-endpoint] { cpuProfileEndTimeUs: ${marker.cpuProfileEndTimeUs}, cpuProfileProcessId: ${child.pid}, cpuProfileSummaryMode: '${marker.cpuProfileSummaryMode}' }`
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

test.each([
  [true, true],
  [true, false],
  [false, true],
])(
  'requires a saved summary only for the before-endpoint mode (case %#)',
  async (beforeEndpoint, hasRawProfile) => {
    const root = await mkdtemp(join(tmpdir(), 'wework-cpu-summary-missing-'))
    roots.push(root)
    const logs = join(root, 'session/electron-user-data/logs')
    const privateRoot = join(root, 'session/electron-user-data/dsh-core/.cpu-profile')
    await mkdir(logs, { recursive: true })
    const raw = join(privateRoot, 'CPU.20261013.120000.10.0.001.cpuprofile')
    if (hasRawProfile) {
      await mkdir(privateRoot, { recursive: true })
      await writeFile(raw, JSON.stringify(fixture()))
    }
    await writeFile(
      join(logs, 'dsh-core-runtime.log'),
      `[startup][core-dsh-endpoint] { cpuProfileEndTimeUs: 5000, cpuProfileProcessId: 10${beforeEndpoint ? ", cpuProfileSummaryMode: 'before-endpoint'" : ''} }`
    )
    const result = await execute('bash', [
      resolve('../.github/scripts/prune-wework-desktop-e2e-diagnostics.sh'),
      root,
    ]).catch(error => error)
    if (beforeEndpoint) {
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Core startup CPU summary is unavailable before endpoint')
      expect(result.stderr).not.toMatch(/private-token|private\/user|secret=|file:\/\//)
      await expect(readFile(join(logs, 'core-startup-cpu-summary-1.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } else {
      expect(result.stderr).toBe('')
      const summary = JSON.parse(
        await readFile(join(logs, 'core-startup-cpu-summary-1.json'), 'utf8')
      )
      expect(summary.scope).toBe('startup-to-endpoint')
    }
    await expect(readFile(raw)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

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

test.each([
  [{ ...fixture(), samples: undefined }, 'core_profile_invalid_shape'],
  [{ ...fixture(), samples: [999, 3, 4] }, 'core_profile_missing_sample_node'],
  [{ ...fixture(), timeDeltas: [NaN, 2, 3] }, 'core_profile_nonfinite_delta'],
  [{ ...fixture(), timeDeltas: [-1, 2, 3] }, 'core_profile_negative_delta'],
])('retains hard validation failures with fixed reasons (case %#)', (profile, code) => {
  expect(() => summarizeCoreCpuProfile(profile)).toThrow('Invalid CPU profile')
  try {
    summarizeCoreCpuProfile(profile)
  } catch (error) {
    expect(error.code).toBe(code)
    expect(error.message).not.toMatch(/private|token|file:/)
  }
})

test('propagates the real summarizer failure through bootstrap and endpoint publication safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cpu-invalid-profile-'))
  roots.push(root)
  const inspector = join(root, 'invalid-profile.mjs')
  await writeFile(
    inspector,
    `import { Session } from 'node:inspector'
const original = Session.prototype.post
Session.prototype.post = function (method, ...args) {
  if (method !== 'Profiler.stop') return original.call(this, method, ...args)
  const callback = args.pop()
  queueMicrotask(() => callback(null, { profile: ${JSON.stringify({ ...fixture(), timeDeltas: [-1, 2, 3] })} }))
}`
  )
  const { stdout } = await execute(
    process.execPath,
    [
      '--import',
      pathToFileURL(inspector).href,
      '--import',
      pathToFileURL(resolve('dsh/electron-host/cpu-profile-bootstrap.js')).href,
      '--input-type=module',
      '-e',
      `import { completeStartupCpuProfile } from ${JSON.stringify(pathToFileURL(resolve('dsh/electron-host/index.js')).href)}; console.log(JSON.stringify(await completeStartupCpuProfile()))`,
    ],
    { env: { ...process.env, WEWORK_E2E_CORE_CPU_PROFILE: '1', DSH_HOME: join(root, 'dsh-core') } }
  )
  const marker = JSON.parse(stdout)
  expect(marker.cpuProfileClockStatus).toBe('failed')
  expect(marker.cpuProfileFailureCode).toBe('core_profile_summarize_failed')
  expect(marker.cpuProfileValidationCode).toBe('core_profile_negative_delta')
  expect(marker).not.toHaveProperty('cpuProfileEndTimeUs')
  expect(stdout).not.toMatch(/private|token|file:/)
  const logs = join(root, 'session/electron-user-data/logs')
  await mkdir(logs, { recursive: true })
  await writeFile(
    join(logs, 'dsh-core-runtime.log'),
    `[startup][core-dsh-endpoint] { cpuProfileClockStatus: 'failed', cpuProfileProcessId: ${marker.cpuProfileProcessId}, cpuProfileSummaryMode: 'before-endpoint', cpuProfileFailureCode: '${marker.cpuProfileFailureCode}', cpuProfileValidationCode: '${marker.cpuProfileValidationCode}' }`
  )
  const result = await execute(process.execPath, [
    resolve('scripts/summarize-core-startup-profiles.mjs'),
    root,
  ]).catch(error => error)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain(
    'Core startup CPU diagnostics failed before endpoint (core_profile_summarize_failed; core_profile_negative_delta)'
  )
  expect(result.stderr).not.toContain('CPU profile startup clock is unavailable')
  expect(result.stderr).not.toMatch(/private|token|file:/)
})

test('keeps missing clocks fatal and excludes unrecognized validation reasons', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cpu-missing-clock-'))
  roots.push(root)
  const logs = join(root, 'session/electron-user-data/logs')
  await mkdir(logs, { recursive: true })
  for (const failure of [
    '',
    ", cpuProfileFailureCode: 'core_profile_summarize_failed', cpuProfileValidationCode: 'private-token/path'",
  ]) {
    await writeFile(
      join(logs, 'dsh-core-runtime.log'),
      `[startup][core-dsh-endpoint] { cpuProfileClockStatus: 'failed', cpuProfileProcessId: 10${failure} }`
    )
    const result = await execute(process.execPath, [
      resolve('scripts/summarize-core-startup-profiles.mjs'),
      root,
    ]).catch(error => error)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      failure ? 'core_profile_summarize_failed' : 'CPU profile startup clock is unavailable'
    )
    expect(result.stderr).not.toContain('private-token')
  }
})
