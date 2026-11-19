import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStartupGdbReady } from './startup-gdb-handshake.mjs'

import {
  logDesktopE2eSignal,
  processGroupIsAlive,
  processIsAlive,
  stopProcessGroup,
} from '../process-lifecycle.mjs'

const IDENTITY_PREFIX = '[startup-gdb-inferior] '
const EXIT_PREFIX = '[startup-gdb-host-exit] '
const CAPTURE_TIMEOUT_MS = 5_000
const SMOKE_TIMEOUT_MS = 10_000
const POLL_MS = 25
const GDB_COMMAND_FILE = fileURLToPath(new URL('./startup-gdb-probe.gdb', import.meta.url))
const SMOKE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))

function readIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  return {
    pid,
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    session: Number(fields[3]),
    starttime: fields[19],
  }
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

async function settleWithin(promise, timeoutMs) {
  let timeout
  try {
    await Promise.race([
      promise,
      new Promise(resolve => {
        timeout = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

/** Linux-only, temporary native diagnostics for the isolated startup children. */
export function spawnStartupGdbProbe(appBinary, args, spawnOptions, { allThreads = true } = {}) {
  assert.equal(process.platform, 'linux', 'The startup GDB probe requires Linux')
  assert.equal(spawnOptions.detached, true, 'GDB must own its process group')
  // Let the fixed POSIX shell interpret GDB's --args escaping and exec the
  // inferior with the same PID. Do not load caller-provided shell startup code.
  const environment = { ...(spawnOptions.env ?? process.env), SHELL: '/bin/sh' }
  delete environment.BASH_ENV
  delete environment.ENV
  const child = spawn(
    'gdb',
    [
      '--quiet',
      '--nx',
      '--batch',
      '--return-child-result',
      '-iex',
      'set auto-load off',
      '-iex',
      'set debuginfod enabled off',
      '-iex',
      'set pagination off',
      '-iex',
      'set confirm off',
      '-iex',
      'set print frame-arguments none',
      '-iex',
      'set startup-with-shell on',
      '-iex',
      'set disable-randomization off',
      '-iex',
      'set follow-fork-mode parent',
      '-iex',
      'set detach-on-fork on',
      '-iex',
      'handle SIGPIPE nostop noprint pass',
      '-iex',
      'handle SIGTERM nostop noprint pass',
      '-ex',
      'show version',
      '-ex',
      'run',
      '-ex',
      allThreads ? 'thread apply all bt' : 'bt',
      '-x',
      GDB_COMMAND_FILE,
      '--args',
      appBinary,
      ...args,
    ],
    { ...spawnOptions, env: environment }
  )
  let output = ''
  let exit = null
  let closed = false
  let identity = null
  let wrapperIdentity = null
  let ownershipError = null
  let printedFailureLength = 0
  const owned = new Map()
  const markers = []
  const identityRecords = []
  const readyRecords = []
  const pending = { stdout: '', stderr: '' }
  const closedPromise = new Promise(resolve => child.once('close', resolve))
  child.once('close', () => {
    closed = true
  })
  child.once('error', error => {
    exit = { error }
  })
  child.once('exit', (code, signal) => {
    exit = { code, signal }
  })

  function observeOwnedChildren() {
    if (!Number.isSafeInteger(child.pid) || exit) return
    try {
      const wrapper = readIdentity(child.pid)
      assert.equal(wrapper.pgid, child.pid, 'GDB lost its owned process group')
      if (wrapperIdentity)
        assert.equal(wrapper.starttime, wrapperIdentity.starttime, 'GDB PID was reused')
      wrapperIdentity = wrapper
      const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')
      for (const value of children.trim().split(/\s+/).filter(Boolean)) {
        const pid = Number(value)
        let record
        try {
          record = readIdentity(pid)
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ESRCH') continue
          throw error
        }
        assert.equal(record.ppid, child.pid, 'The startup inferior must be a direct GDB child')
        assert.equal(record.session, wrapper.session, 'The startup inferior changed session')
        if (owned.has(pid))
          assert.equal(record.starttime, owned.get(pid).starttime, 'Inferior PID was reused')
        owned.set(pid, record)
        assert.ok(
          record.pgid === child.pid || record.pgid === pid,
          `Unsupported startup process group: ${JSON.stringify(record)}`
        )
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') ownershipError ??= error
    }
  }

  function acceptLine(line) {
    if (line.startsWith(EXIT_PREFIX)) markers.push(line.slice(EXIT_PREFIX.length))
    try {
      const ready = parseStartupGdbReady(line)
      if (ready) {
        readyRecords.push(ready)
        assert.equal(readyRecords.length, 1, 'Expected one GDB smoke ready marker')
        assert.equal(ready.pid, identity?.pid, 'The ready marker must belong to the owned inferior')
        return
      }
    } catch (error) {
      ownershipError ??= error
      return
    }
    if (!line.startsWith(IDENTITY_PREFIX)) return
    try {
      const reported = JSON.parse(line.slice(IDENTITY_PREFIX.length))
      identityRecords.push(reported)
      for (const field of ['pid', 'ppid', 'pgid']) assert.ok(Number.isSafeInteger(reported[field]))
      assert.equal(reported.ppid, child.pid, 'The identity marker must belong to this GDB child')
      const record = owned.get(reported.pid)
      assert.ok(record, 'The startup inferior was not observed under this GDB process')
      assert.deepEqual(reported, { pid: record.pid, ppid: record.ppid, pgid: record.pgid })
      identity = record
    } catch (error) {
      ownershipError ??= error
    }
  }

  for (const stream of ['stdout', 'stderr']) {
    assert.ok(child[stream], `The GDB probe requires a piped ${stream}`)
    child[stream].on('data', chunk => {
      // In particular, observe the paused inferior before forwarding its inspector URL.
      // Only GDB's own direct-child proc files are inspected during execution.
      observeOwnedChildren()
      const text = chunk.toString()
      output += text
      pending[stream] += text
      const lines = pending[stream].split('\n')
      pending[stream] = lines.pop()
      for (const line of lines) acceptLine(line.trimEnd())
    })
  }

  async function assertNormalExit(actualExit) {
    assert.deepEqual(actualExit, { code: 0, signal: null }, output)
    assert.deepEqual(exit, actualExit, 'The native exit gate requires the observed GDB exit')
    // Exit can precede the last pipe read. Do not let an unread marker become a false failure.
    await settleWithin(closedPromise, 1_000)
    if (ownershipError) throw ownershipError
    assert.equal(identityRecords.length, 1, `Expected one inferior identity marker\n${output}`)
    assert.ok(identity, `Missing owned startup inferior\n${output}`)
    assert.deepEqual(markers, ['0'], `Expected exactly one normal native host exit\n${output}`)
  }

  async function captureFailure() {
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS
    try {
      observeOwnedChildren()
      if (!exit && Number.isSafeInteger(child.pid) && processIsAlive(child.pid)) {
        logDesktopE2eSignal({ action: 'startup-gdb-interrupt', pid: child.pid, signal: 'SIGINT' })
        // Interrupt the debugger only; GDB stops its own inferior and prints the stack.
        child.kill('SIGINT')
      }
      await settleWithin(closedPromise, Math.max(0, deadline - Date.now()))
    } catch (error) {
      // Diagnostics must never replace the first startup assertion or timeout.
      console.log('[startup-gdb-capture-error]', error.code ?? error.message)
    } finally {
      const collected = output.slice(printedFailureLength)
      printedFailureLength = output.length
      if (collected)
        console.log(`[startup-gdb-failure-output] wrapper=${child.pid ?? 'unknown'}\n${collected}`)
    }
  }

  async function cleanup() {
    observeOwnedChildren()
    let failure = ownershipError
    try {
      if (wrapperIdentity && processIsAlive(child.pid)) {
        assert.equal(
          readIdentity(child.pid).starttime,
          wrapperIdentity.starttime,
          'Refusing cleanup of a reused GDB PID'
        )
      }
      await stopProcessGroup(child)
    } catch (error) {
      failure = error
    }
    for (const record of owned.values()) {
      try {
        let current
        try {
          current = readIdentity(record.pid)
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
        }
        if (current) {
          assert.equal(current.starttime, record.starttime, 'Refusing cleanup of a reused PID')
          assert.equal(current.pgid, record.pgid, 'Refusing cleanup after a process group change')
        }
        if (record.pgid === child.pid) continue
        if (record.pgid !== record.pid) {
          if (current && processIsAlive(record.pid)) {
            logDesktopE2eSignal({
              action: 'startup-gdb-cleanup',
              pid: record.pid,
              signal: 'SIGKILL',
            })
            process.kill(record.pid, 'SIGKILL')
          }
          throw new Error(`Unsupported startup process group: ${JSON.stringify(record)}`)
        }
        for (const signal of ['SIGTERM', 'SIGKILL']) {
          if (!processGroupIsAlive(record.pgid)) break
          logDesktopE2eSignal({ action: 'startup-gdb-cleanup', pgid: record.pgid, signal })
          try {
            process.kill(-record.pgid, signal)
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
          await waitUntil(
            () => !processGroupIsAlive(record.pgid),
            signal === 'SIGTERM' ? 250 : CAPTURE_TIMEOUT_MS,
            `Startup inferior group ${record.pgid} survived ${signal}`
          ).catch(error => {
            if (signal === 'SIGKILL') throw error
          })
        }
        assert.equal(processIsAlive(record.pid), false, 'The startup inferior survived cleanup')
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
  }

  return {
    child,
    assertNormalExit,
    captureFailure,
    cleanup,
    get output() {
      return output
    },
    get identity() {
      if (ownershipError) throw ownershipError
      return identity
    },
    get ready() {
      if (ownershipError) throw ownershipError
      return readyRecords[0] ?? null
    },
    get exit() {
      return exit
    },
    get closed() {
      return closed
    },
  }
}

/** Real GDB smoke cases; their negative outcomes must fail the production exit gate. */
export async function verifyStartupGdbContract({ resultDir }) {
  assert.equal(process.platform, 'linux', 'The startup GDB contract requires Linux')
  await mkdir(resultDir, { recursive: true })
  const argumentsToPreserve = [
    '',
    'two  words',
    "single 'quoted' word",
    'double "quoted" word',
    'back\\slash',
    'trailing\\',
    '$WEWORK_E2E_GDB_LITERAL',
    '${IFS}',
    'startup-gdb-*.mjs',
    '',
    'C:\\Program Files\\WeWork\\workbench.exe',
    '',
  ]
  for (const mode of ['normal', 'trap', 'interrupt']) {
    const handshakeDeadline = Date.now() + SMOKE_TIMEOUT_MS
    // Both Unit and Core must preserve these literal arguments through their
    // installed GDB versions before the fixture accepts its acknowledgement.
    const probe = spawnStartupGdbProbe(
      process.execPath,
      ['startup-gdb-smoke.mjs', mode, ...argumentsToPreserve],
      {
        cwd: SMOKE_DIRECTORY,
        env: {
          PATH: '/usr/bin:/bin',
          LC_ALL: 'C',
          WEWORK_E2E_GDB_EXPECTED_ARGUMENTS: JSON.stringify(argumentsToPreserve),
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      }
    )
    let failure
    let inferiorPid
    let handshakeError
    probe.child.stdio[3].on('error', error => {
      handshakeError = error
    })
    try {
      await waitUntil(
        () => {
          if (probe.exit?.error) throw probe.exit.error
          if (probe.exit) throw new Error(`GDB ${mode} exited before its ownership handshake`)
          return probe.identity !== null
        },
        Math.max(0, handshakeDeadline - Date.now()),
        `GDB ${mode} did not report its owned inferior\n${probe.output}`
      )
      inferiorPid = probe.identity.pid
      probe.child.stdio[3].end(Buffer.from([1]))
      await waitUntil(
        () => {
          if (handshakeError) throw handshakeError
          if (probe.ready) {
            assert.deepEqual(probe.ready, { pid: inferiorPid, mode })
            return true
          }
          if (probe.exit?.error) throw probe.exit.error
          if (probe.exit && probe.closed)
            throw new Error(`GDB ${mode} exited before consuming its acknowledgement`)
          return false
        },
        Math.max(0, handshakeDeadline - Date.now()),
        `GDB ${mode} did not finish its acknowledgement handshake\n${probe.output}`
      )
      if (mode === 'interrupt') await probe.captureFailure()
      await waitUntil(
        () => {
          if (handshakeError) throw handshakeError
          return probe.exit !== null && probe.closed
        },
        SMOKE_TIMEOUT_MS,
        `GDB ${mode} did not finish\n${probe.output}`
      )
      assert.equal(probe.identity.pid, inferiorPid, 'GDB smoke lost its owned inferior identity')
      if (mode === 'normal') await probe.assertNormalExit(probe.exit)
      else {
        await assert.rejects(probe.assertNormalExit(probe.exit))
        assert.doesNotMatch(probe.output, /^\[startup-gdb-host-exit\] 0\s*$/m)
        assert.match(
          probe.output,
          mode === 'trap' ? /received signal SIGTRAP,/ : /received signal SIGINT,/
        )
        assert.match(probe.output, /^#0\s+/m, `GDB ${mode} did not capture a native stack`)
      }
    } catch (error) {
      failure = error
      await probe.captureFailure()
    } finally {
      try {
        await probe.cleanup()
        if (inferiorPid) assert.equal(processIsAlive(inferiorPid), false)
      } catch (error) {
        failure ??= error
      }
      await writeFile(join(resultDir, `startup-gdb-${mode}.log`), probe.output)
    }
    if (failure) throw failure
    const version =
      mode === 'normal'
        ? `; ${probe.output.match(/^GNU gdb[^\r\n]*/m)?.[0] ?? 'GDB version unavailable'}`
        : ''
    console.log(`[startup-gdb-contract] ${mode} passed; inferior ${inferiorPid} is gone${version}`)
  }
}
