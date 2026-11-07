import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { diskRootMetadata, openDeletedDiskFiles } from './runner-process-disk.mjs'

const script = fileURLToPath(new URL('./run-with-resource-logging.mjs', import.meta.url))

function processDiskFixture() {
  const reads = []
  const descriptors = new Map()
  const parents = { 10: 1, 11: 10, 12: 11, 20: 1 }
  const io = {
    readdirSync(path) {
      reads.push(path)
      if (path === '/proc') return [...Object.keys(parents), 'self']
      return [...descriptors.keys()]
        .filter(key => key.startsWith(`${path}/`))
        .map(key => key.split('/').at(-1))
    },
    readFileSync(path) {
      reads.push(path)
      const [, , pid, name] = path.split('/')
      if (name === 'status') return `PPid:\t${parents[pid]}\n`
      assert.equal(name, 'comm')
      return 'owned-process\n'
    },
    statSync(path) {
      reads.push(path)
      const descriptor = descriptors.get(path)
      if (descriptor.error) throw Object.assign(new Error('fixture'), { code: descriptor.error })
      return {
        dev: 1,
        ino: Number(path.split('/').at(-1)),
        blocks: 4096,
        size: 2 * 1024 ** 2,
        nlink: 0,
        isFile: () => true,
        ...descriptor,
      }
    },
    readlinkSync(path) {
      reads.push(path)
      if (path.endsWith('/ns/mnt')) return path.includes('/12/') ? 'mnt:[2]' : 'mnt:[1]'
      return `/tmp/owned-${path.split('/').at(-1)} (deleted)`
    },
  }
  return { io, reads, descriptors }
}

test('counts unique large unlinked files only on the owned process tree and filesystem', () => {
  const fixture = processDiskFixture()
  for (const [path, descriptor] of [
    ['/proc/10/fd/1', { ino: 1 }],
    ['/proc/11/fd/2', { ino: 1 }],
    ['/proc/12/fd/3', { ino: 3, blocks: 8192 }],
    ['/proc/11/fd/4', { nlink: 1 }],
    ['/proc/11/fd/5', { isFile: () => false }],
    ['/proc/11/fd/6', { blocks: 1 }],
    ['/proc/11/fd/7', { dev: 2 }],
    ['/proc/20/fd/8', {}],
  ])
    fixture.descriptors.set(path, descriptor)
  const result = openDeletedDiskFiles(10, 1, fixture)
  assert.equal(result.allocatedBytes, 6 * 1024 ** 2)
  assert.deepEqual(
    result.files.map(file => file.pid),
    [12, 10]
  )
  assert.equal(result.truncated, false)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.mountNamespaces, { 'mnt:[1]': 2, 'mnt:[2]': 1 })
  assert.deepEqual(result.excludedDevices, {
    2: {
      files: 1,
      allocatedBytes: 2 * 1024 ** 2,
      firstHolders: { 11: { files: 1, allocatedBytes: 2 * 1024 ** 2 } },
    },
  })
  assert.deepEqual(result.excludedFiles, [
    {
      pid: 11,
      process: 'owned-process',
      device: 2,
      path: '/tmp/owned-7 (deleted)',
      sizeBytes: 2 * 1024 ** 2,
      allocatedBytes: 2 * 1024 ** 2,
    },
  ])
  assert.ok(!fixture.reads.some(path => path.startsWith('/proc/20/fd')))
  assert.ok(
    fixture.reads.every(path =>
      /^\/proc(?:\/\d+\/(?:status|comm|ns\/mnt|fd(?:\/\d+)?))?$/.test(path)
    )
  )
})

test('distinguishes filesystem devices and preserves unavailable root metadata', () => {
  const io = {
    statSync: path => ({ dev: path === '.' ? 1 : 2 }),
    statfsSync(path) {
      if (path === '/missing') throw Object.assign(new Error('fixture'), { code: 'ENOENT' })
      return { type: 42, blocks: 100, bavail: 20, bsize: 4096 }
    },
  }
  assert.deepEqual(diskRootMetadata(['.', '/tmp', '/missing'], io), [
    { path: '.', device: 1, filesystemType: 42, totalBytes: 409600, availableBytes: 81920 },
    { path: '/tmp', device: 2, filesystemType: 42, totalBytes: 409600, availableBytes: 81920 },
    { path: '/missing', unavailable: 'ENOENT' },
  ])
})

test('keeps partial metadata after process disappearance or permission denial', () => {
  const fixture = processDiskFixture()
  fixture.descriptors.set('/proc/10/fd/1', {})
  fixture.descriptors.set('/proc/11/fd/2', { error: 'ENOENT' })
  fixture.descriptors.set('/proc/12/fd/3', { error: 'EACCES' })
  const result = openDeletedDiskFiles(10, 1, fixture)
  assert.equal(result.files.length, 1)
  assert.equal(result.allocatedBytes, 2 * 1024 ** 2)
  assert.deepEqual(result.errors, ['ENOENT', 'EACCES'])
})

test('bounds process inspection time and skips inspection without a child', () => {
  const fixture = processDiskFixture()
  openDeletedDiskFiles(undefined, 1, fixture)
  assert.deepEqual(fixture.reads, [])
  let elapsed = 0
  const result = openDeletedDiskFiles(10, 1, {
    ...fixture,
    now: () => elapsed++,
    budgetMs: 3,
  })
  assert.equal(result.truncated, true)
  assert.ok(fixture.reads.length <= 3)
})

test('caps emitted file metadata while retaining total allocated bytes', () => {
  const fixture = processDiskFixture()
  for (let index = 1; index <= 25; index++) fixture.descriptors.set(`/proc/10/fd/${index}`, {})
  const result = openDeletedDiskFiles(10, 1, fixture)
  assert.equal(result.files.length, 20)
  assert.equal(result.allocatedBytes, 50 * 1024 ** 2)
})

test('bounds other-device metadata and attributes unique files to their first holder', () => {
  const fixture = processDiskFixture()
  for (let index = 1; index <= 25; index++) {
    fixture.descriptors.set(`/proc/10/fd/${index}`, { dev: 2 })
  }
  fixture.descriptors.set('/proc/10/fd/26', { dev: 2, ino: 26, blocks: 8192 })
  fixture.descriptors.set('/proc/11/fd/27', { dev: 2, ino: 26, blocks: 8192 })
  const result = openDeletedDiskFiles(10, 1, fixture)
  assert.equal(result.allocatedBytes, 0)
  assert.equal(result.excludedFiles.length, 20)
  assert.equal(result.excludedFiles[0].path, '/tmp/owned-26 (deleted)')
  assert.deepEqual(result.excludedDevices, {
    2: {
      files: 26,
      allocatedBytes: 54 * 1024 ** 2,
      firstHolders: { 10: { files: 26, allocatedBytes: 54 * 1024 ** 2 } },
    },
  })
  assert.equal(fixture.reads.filter(path => path.endsWith('/comm')).length, 1)
})

test('preserves cross-device allocation when file description becomes unavailable', () => {
  const fixture = processDiskFixture()
  fixture.descriptors.set('/proc/10/fd/1', { ino: 1 })
  fixture.descriptors.set('/proc/10/fd/2', { dev: 2, ino: 1 })
  fixture.descriptors.set('/proc/11/fd/3', { dev: 2, ino: 1 })
  const readlink = fixture.io.readlinkSync
  fixture.io.readlinkSync = path => {
    if (path === '/proc/10/fd/2') throw Object.assign(new Error('fixture'), { code: 'EACCES' })
    return readlink(path)
  }
  const result = openDeletedDiskFiles(10, 1, fixture)
  assert.equal(result.allocatedBytes, 2 * 1024 ** 2)
  assert.deepEqual(result.excludedDevices, {
    2: {
      files: 1,
      allocatedBytes: 2 * 1024 ** 2,
      firstHolders: { 10: { files: 1, allocatedBytes: 2 * 1024 ** 2 } },
    },
  })
  assert.deepEqual(result.excludedFiles, [])
  assert.deepEqual(result.errors, ['EACCES'])
})

function run(args, env = {}, preload) {
  const cwd = mkdtempSync(join(tmpdir(), 'runner-resource-test-'))
  try {
    if (preload) {
      const preloadPath = join(cwd, 'preload.mjs')
      writeFileSync(preloadPath, preload)
      env = { ...env, NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` }
    }
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 25_000,
      env: { ...process.env, ...env },
    })
    assert.ifError(result.error)
    const records = readFileSync(
      join(
        cwd,
        env.RUNNER_RESOURCE_LOG_PATH ?? 'wework/test-results/desktop-e2e/runner-resources.jsonl'
      ),
      'utf8'
    )
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    return { ...result, records }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

test('supports high-frequency resource diagnostics without periodic process spawning', () => {
  const result = run([process.execPath, '-e', 'setTimeout(() => process.exit(23), 450)'], {
    RUNNER_RESOURCE_SAMPLE_INTERVAL_MS: '100',
    RUNNER_PROCESS_DIAGNOSTICS: '1',
  })
  assert.equal(result.status, 23)
  assert.equal(result.records[0].sampleIntervalMs, 100)
  const intervals = result.records.filter(record => record.phase === 'interval')
  assert.ok(intervals.length > 0)
  for (const record of intervals) {
    assert.equal(record.processes, undefined)
    assert.ok(record.schedulingDelayMs >= 0)
  }
  assert.ok(result.records[0].processes)
  assert.ok(result.records.at(-1).processes)
})

test('rejects invalid sampling intervals before starting the command', () => {
  for (const interval of ['0', '99', '100.5', 'invalid']) {
    const result = spawnSync(
      process.execPath,
      [script, process.execPath, '-e', 'process.exit(0)'],
      {
        encoding: 'utf8',
        env: { ...process.env, RUNNER_RESOURCE_SAMPLE_INTERVAL_MS: interval },
      }
    )
    assert.ifError(result.error)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must be an integer of at least 100/)
  }
})

test('records periodic resources and preserves command arguments and failure exit', () => {
  const result = run([
    process.execPath,
    '-e',
    'console.log(process.argv[1]); setTimeout(() => process.exit(23), 16000)',
    'argument with spaces',
  ])
  assert.equal(result.status, 23)
  assert.match(result.stdout, /argument with spaces/)
  assert.deepEqual(
    result.records.map(record => record.phase),
    ['start', 'interval', 'end']
  )
  assert.equal(result.records.at(-1).exitCode, 23)
  const sample = result.records[1]
  assert.ok(sample.cpuCount > 0)
  assert.ok(sample.memoryTotalBytes > 0)
  assert.ok(sample.diskAvailableBytes >= 0)
  assert.ok(sample.cpuBusyPercent >= 0 && sample.cpuBusyPercent <= 100)
  if (process.platform === 'linux') {
    assert.match(sample.linux.memory, /MemAvailable:/)
    assert.ok(sample.linux.cgroupMemoryEvents)
  }
})

test('reports a command that cannot start and returns a failure', () => {
  const result = run(['/nonexistent/wework-resource-test-command'])
  assert.equal(result.status, 127)
  assert.match(result.stderr, /Command failed to start: ENOENT/)
  assert.deepEqual(
    result.records.map(record => record.phase),
    ['start', 'end']
  )
})

test('preserves child termination signals', () => {
  const result = run([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'])
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(result.records.at(-1).phase, 'end')
})

test('records process identities in a configurable artifact without command arguments', () => {
  const result = run([process.execPath, '-e', 'process.exit(0)', 'private-command-argument'], {
    RUNNER_PROCESS_DIAGNOSTICS: '1',
    RUNNER_RESOURCE_LOG_PATH: 'diagnostics/resources.jsonl',
  })
  assert.equal(result.status, 0)
  assert.ok(result.records.at(-1).commandPid > 0)
  for (const record of result.records) {
    assert.match(record.processes, /PID\s+PPID/)
    assert.doesNotMatch(record.processes, /private-command-argument/)
  }
})

for (const { name, output, directories } of [
  {
    name: 'partial',
    output: '8\tfixture cache\n',
    directories: [{ allocatedBytes: 8192, path: 'fixture cache' }],
  },
  { name: 'empty', output: '', directories: [] },
]) {
  test(`retains ${name} disk diagnostics without changing the child failure`, () => {
    const result = run(
      [process.execPath, '-e', 'process.exit(23)'],
      {},
      `
      import fs from 'node:fs'
      import childProcess from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      const statfs = fs.statfsSync
      fs.statfsSync = path => ({ ...statfs(path), bavail: 0, ffree: 17 })
      childProcess.execFileSync = () => {
        const error = new Error('A directory disappeared during the scan')
        error.status = 1
        error.stdout = ${JSON.stringify(output)}
        throw error
      }
      Object.defineProperty(process, 'platform', { value: 'linux' })
      syncBuiltinESMExports()
    `
    )
    assert.equal(result.status, 23)
    assert.equal(result.records[0].diskAvailableInodes, 17)
    assert.deepEqual(result.records[0].diskUsage.directories, directories)
    assert.equal(result.records[0].diskUsage.incomplete.status, 1)
    assert.equal(result.records.at(-1).diskUsage, undefined)
    assert.equal(result.records.at(-1).exitCode, 23)
  })
}

for (const { remainingGiB, triggers } of [
  { remainingGiB: 73, triggers: ['growth'] },
  { remainingGiB: 1, triggers: ['low_free', 'growth'] },
]) {
  test(`captures disk growth once with ${remainingGiB} GiB remaining`, () => {
    const result = run(
      [process.execPath, '-e', 'process.exit(23)'],
      { WEWORK_E2E_PARALLEL_CHECKPOINTS: '4' },
      `
        import fs from 'node:fs'
        import childProcess from 'node:child_process'
        import { syncBuiltinESMExports } from 'node:module'
        const statfs = fs.statfsSync
        let samples = 0
        let scans = 0
        fs.statfsSync = path => {
          const current = statfs(path)
          const available = (samples++ === 0 ? 85 : ${remainingGiB}) * 1024 ** 3
          return { ...current, bavail: available / current.bsize }
        }
        childProcess.execFileSync = (_command, args) =>
          String(++scans) + '\\tdepth-' + args[3] + '\\n'
        Object.defineProperty(process, 'platform', { value: 'linux' })
        syncBuiltinESMExports()
      `
    )
    assert.equal(result.status, 23)
    assert.deepEqual(result.records[0].diskUsage.triggers, ['baseline'])
    assert.deepEqual(result.records[0].diskUsage.directories, [
      { allocatedBytes: 1024, path: 'depth-1' },
    ])
    const end = result.records.at(-1)
    assert.equal(end.diskInitialAvailableBytes, 85 * 1024 ** 3)
    assert.equal(end.diskAvailableBytes, remainingGiB * 1024 ** 3)
    assert.equal(end.diskAvailableDecreaseBytes, (85 - remainingGiB) * 1024 ** 3)
    assert.deepEqual(end.diskUsage.triggers, triggers)
    assert.deepEqual(end.diskUsage.directories, [{ allocatedBytes: 2048, path: 'depth-4' }])
    assert.equal(end.exitCode, 23)
  })
}

test('samples owned files once at a configured time without disk pressure or another directory scan', () => {
  const result = run(
    [process.execPath, '-e', 'setTimeout(() => process.exit(23), 100)'],
    { WEWORK_E2E_PARALLEL_CHECKPOINTS: '4', RUNNER_PROCESS_SAMPLE_AFTER_MS: '1' },
    `
      import fs from 'node:fs'
      import childProcess from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      const statfs = fs.statfsSync
      fs.statfsSync = path => {
        const current = statfs(path)
        return { ...current, bavail: 85 * 1024 ** 3 / current.bsize }
      }
      childProcess.execFileSync = () => '8\\tbaseline\\n'
      const interval = globalThis.setInterval
      globalThis.setInterval = (callback, delay) => interval(callback, delay === 15000 ? 10 : delay)
      Object.defineProperty(process, 'platform', { value: 'linux' })
      syncBuiltinESMExports()
    `
  )
  assert.equal(result.status, 23)
  const samples = result.records.filter(record => record.openDeletedDiskFiles)
  assert.equal(samples.length, 1)
  assert.deepEqual(samples[0].openDeletedDiskFiles.triggers, ['scheduled'])
  assert.ok(samples[0].elapsedMs >= 1)
  assert.equal(samples[0].diskAvailableDecreaseBytes, 0)
  assert.equal(samples[0].diskUsage, undefined)
  assert.equal(result.records.filter(record => record.diskUsage).length, 1)
  assert.equal(result.records.at(-1).exitCode, 23)
})
