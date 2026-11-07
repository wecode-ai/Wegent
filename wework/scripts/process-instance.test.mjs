import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectProcessInstanceIdentity } from '../e2e/desktop/process-instance.mjs'

const BOOT_ID = '5df4163a-5c1d-449f-83eb-bbb652a29213'

test('reads the current runner process identity consistently from the native host', async () => {
  const before = await collectProcessInstanceIdentity(process.pid)
  assert.equal(before.pid, process.pid)
  assert.deepEqual(await collectProcessInstanceIdentity(process.pid), before)
})

function linuxReader({ startTicks = '9007199254740993', bootId = BOOT_ID, statError } = {}) {
  return async path => {
    if (path === '/proc/sys/kernel/random/boot_id') return `${bootId}\n`
    assert.equal(path, '/proc/42/stat')
    if (statError) throw statError
    // comm contains spaces and a closing parenthesis, while starttime is field 22.
    return `42 (odd ) process) S ${Array(18).fill('0').join(' ')} ${startTicks} 0 0\n`
  }
}

test('uses exact Linux start ticks and boot identity without numeric precision loss', async () => {
  const identity = await collectProcessInstanceIdentity(42, {
    platform: 'linux',
    readText: linuxReader(),
  })
  assert.deepEqual(identity, {
    pid: 42,
    creationToken: `linux:${BOOT_ID}:9007199254740993`,
  })
})

test('detects Linux PID reuse and a different boot even when the PID is unchanged', async () => {
  const collect = options =>
    collectProcessInstanceIdentity(42, { platform: 'linux', readText: linuxReader(options) })
  const original = await collect()
  assert.notDeepEqual(await collect({ startTicks: '9007199254740994' }), original)
  assert.notDeepEqual(await collect({ bootId: '8d6afdc1-9cb5-4576-9329-463314e4432f' }), original)
})

test('returns null only for an exited Linux PID and surfaces read or malformed identity errors', async () => {
  for (const code of ['ENOENT', 'ESRCH']) {
    assert.equal(
      await collectProcessInstanceIdentity(42, {
        platform: 'linux',
        readText: linuxReader({ statError: Object.assign(new Error('gone'), { code }) }),
      }),
      null
    )
  }
  await assert.rejects(
    collectProcessInstanceIdentity(42, {
      platform: 'linux',
      async readText() {
        throw Object.assign(new Error('boot identity unavailable'), { code: 'ENOENT' })
      },
    }),
    /boot identity unavailable/
  )
  await assert.rejects(
    collectProcessInstanceIdentity(42, {
      platform: 'linux',
      readText: linuxReader({ statError: Object.assign(new Error('denied'), { code: 'EACCES' }) }),
    }),
    /denied/
  )
  for (const options of [{ startTicks: 'invalid' }, { startTicks: '0' }, { bootId: 'unknown' }]) {
    await assert.rejects(
      collectProcessInstanceIdentity(42, { platform: 'linux', readText: linuxReader(options) })
    )
  }
})

test('uses the native macOS lstart field in a fixed locale instead of elapsed-time estimates', async () => {
  const identity = await collectProcessInstanceIdentity(42, {
    platform: 'darwin',
    async executeFile(file, args, options) {
      assert.equal(file, '/bin/ps')
      assert.deepEqual(args, ['-p', '42', '-o', 'lstart='])
      assert.equal(options.env.LC_ALL, 'C')
      return { stdout: '  Fri Nov  6 15:56:05 2026    \n' }
    },
  })
  assert.deepEqual(identity, { pid: 42, creationToken: 'darwin:Fri Nov 6 15:56:05 2026' })
})

test('distinguishes an exited macOS PID from a failed or incomplete native query', async () => {
  const collect = executeFile =>
    collectProcessInstanceIdentity(42, { platform: 'darwin', executeFile })
  assert.equal(
    await collect(async () => {
      throw Object.assign(new Error('gone'), { code: 1, stdout: '', stderr: '' })
    }),
    null
  )
  await assert.rejects(
    collect(async () => {
      throw Object.assign(new Error('query failed'), { code: 1, stderr: 'permission denied' })
    }),
    /query failed/
  )
  await assert.rejects(
    collect(async () => ({ stdout: '' })),
    /Missing macOS/
  )
})

test('reuses the Windows native StartTime identity with its full precision', async () => {
  const startedAt = '2026-11-06T07:59:01.1234567Z'
  const identity = await collectProcessInstanceIdentity(42, {
    platform: 'win32',
    async readWindowsIdentity(pid) {
      assert.equal(pid, 42)
      return { Id: pid, ProcessName: 'codex', StartedAt: startedAt }
    },
  })
  assert.deepEqual(identity, { pid: 42, creationToken: `win32:${startedAt}` })
  assert.equal(
    await collectProcessInstanceIdentity(42, {
      platform: 'win32',
      readWindowsIdentity: async () => null,
    }),
    null
  )
})

test('fails closed for a different Windows PID, invalid PID or unsupported host', async () => {
  await assert.rejects(
    collectProcessInstanceIdentity(42, {
      platform: 'win32',
      readWindowsIdentity: async () => ({
        Id: 43,
        ProcessName: 'codex',
        StartedAt: '2026-11-06T07:59:01.1234567Z',
      }),
    }),
    /Unexpected Windows process PID/
  )
  await assert.rejects(collectProcessInstanceIdentity(0), /positive PID/)
  await assert.rejects(collectProcessInstanceIdentity(42, { platform: 'freebsd' }), /Unsupported/)
})
