import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { E2EErrorLog } from '../../electron/src/host/e2e-error-journal.mjs'
import { PROCESS_STOP_TIMEOUT_MS } from './process-lifecycle.mjs'

/** The native supervisor owns a Job Object before the application is resumed. */
export async function spawnSupervisedWindowsProcess(
  supervisorBinary,
  program,
  args,
  options,
  { launch = spawn, token = randomUUID(), observeSupervisor = () => {}, errorLogPath } = {}
) {
  const supervisor = launch(
    supervisorBinary,
    ['--supervise-process-tree', token, program, ...args],
    {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    }
  )
  const journal = new E2EErrorLog(errorLogPath)
  const identity = {
    observerPid: process.pid,
    ownerPid: supervisor.pid,
    role: 'windows-process-supervisor',
  }
  journal.record('process', 'registered', 'info', identity)
  const app = new EventEmitter()
  Object.assign(app, {
    pid: null,
    exitCode: null,
    signalCode: null,
    stdout: supervisor.stdout,
    stderr: new PassThrough(),
    supervisorPid: supervisor.pid,
    supervisorOutput: new PassThrough(),
  })
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let resolveFinished
  let rejectFinished
  const finished = new Promise((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })
  finished.catch(() => undefined)
  let stopped = null
  let failureMessage = null
  let stopRequested = false
  let pending = Buffer.alloc(0)
  const prefix = `wework-process-tree ${token} `
  const startupTimer = setTimeout(() => {
    rejectReady(new Error('The owned Windows process supervisor did not identify its child'))
    supervisor.kill('SIGKILL')
  }, PROCESS_STOP_TIMEOUT_MS)
  const line = bytes => {
    const text = bytes.toString('utf8').trimEnd()
    if (!text.startsWith(prefix)) {
      app.supervisorOutput.write(bytes)
      return
    }
    const fields = text.slice(prefix.length).split(' ')
    if (fields[0] === 'app-stderr' && fields.length === 2) {
      const decoded = Buffer.from(fields[1], 'base64')
      if (decoded.toString('base64') === fields[1]) {
        if (!app.stderr.write(decoded)) {
          supervisor.stderr.pause()
          app.stderr.once('drain', () => supervisor.stderr.resume())
        }
        return
      }
      failureMessage = 'Invalid application stderr envelope'
      supervisor.kill('SIGKILL')
      return
    }
    app.supervisorOutput.write(bytes)
    if (fields[0] === 'failed') {
      failureMessage = text.slice(prefix.length + 'failed '.length)
      return
    }
    if (
      fields[0] === 'started' &&
      fields.length === 2 &&
      app.pid === null &&
      /^\d+$/.test(fields[1])
    ) {
      app.pid = Number(fields[1])
      if (Number.isSafeInteger(app.pid) && app.pid > 0) {
        clearTimeout(startupTimer)
        resolveReady(app)
        return
      }
    } else if (
      fields[0] === 'stopped' &&
      fields.length === 4 &&
      Number(fields[1]) === app.pid &&
      /^-?\d+$/.test(fields[2]) &&
      fields[3] === '0'
    ) {
      stopped = { rootExitCode: Number(fields[2]), activeProcesses: 0 }
      return
    }
    failureMessage = 'Invalid owned process supervisor identity'
    rejectReady(new Error(failureMessage))
    supervisor.kill('SIGKILL')
  }
  supervisor.stderr.on('data', chunk => {
    pending = Buffer.concat([pending, chunk])
    for (let end; (end = pending.indexOf(10)) !== -1; ) {
      line(pending.subarray(0, end + 1))
      pending = pending.subarray(end + 1)
    }
    if (pending.length > 64 * 1024) {
      app.supervisorOutput.write(pending)
      pending = Buffer.alloc(0)
    }
  })
  app.supervisorOutput.on('data', bytes => {
    journal.record('process', 'supervisor-output', 'info', { ...identity, message: String(bytes) })
  })
  supervisor.once('error', error => {
    journal.record('process', 'supervisor-error', 'error', {
      ...identity,
      message: error.message,
      code: error.code,
    })
    clearTimeout(startupTimer)
    rejectReady(error)
    rejectFinished(error)
    if (app.listenerCount('error')) app.emit('error', error)
  })
  supervisor.once('close', (code, signal) => {
    clearTimeout(startupTimer)
    if (pending.length) line(pending)
    app.stderr.end()
    app.supervisorOutput.end()
    app.exitCode = stopped?.rootExitCode ?? code
    app.signalCode = signal
    journal.record(
      'process',
      'supervisor-closed',
      code === 0 && stopped && !failureMessage ? 'info' : 'error',
      {
        ...identity,
        appPid: app.pid,
        exitCode: code,
        signal,
        activeProcesses: stopped?.activeProcesses ?? null,
        message: failureMessage,
      }
    )
    app.supervisorCollection = journal.checkpoint()
    if (code === 0 && stopped && !failureMessage && app.supervisorCollection.failedWrites === 0)
      resolveFinished(stopped)
    else {
      const error = new Error(
        `Owned Windows process job shutdown was not verified: exit=${code}, signal=${signal}, cause=${failureMessage ?? 'missing native completion'}`
      )
      error.code = 'ERR_WINDOWS_PROCESS_TREE_TERMINATION'
      error.processId = app.pid
      error.supervisorPid = supervisor.pid
      rejectReady(error)
      rejectFinished(error)
      if (app.listenerCount('error')) app.emit('error', error)
    }
    app.emit('exit', app.exitCode, app.signalCode)
    app.emit('close', app.exitCode, app.signalCode)
  })
  supervisor.stdin.on('error', error => {
    journal.record('process', 'supervisor-control-error', 'error', {
      ...identity,
      code: error.code,
    })
    failureMessage = `Supervisor control pipe failed: ${error.code ?? error.name}`
    if (!app.supervisorOutput.writableEnded) {
      app.supervisorOutput.write(
        JSON.stringify({
          source: 'driver-control',
          observerPid: process.pid,
          supervisorPid: supervisor.pid,
          code: error.code ?? null,
        }) + '\n'
      )
    }
  })
  app.kill = () => {
    if (stopRequested) return true
    if (supervisor.stdin.destroyed) return false
    stopRequested = true
    supervisor.stdin.end('stop\n')
    return true
  }
  app.stopOwnedProcessTree = async () => {
    if (app.exitCode === null && app.signalCode === null) app.kill()
    let timer
    try {
      return await Promise.race([
        finished,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            supervisor.kill('SIGKILL')
            reject(new Error('Timed out stopping the owned Windows process job'))
          }, PROCESS_STOP_TIMEOUT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    observeSupervisor({
      pid: supervisor.pid,
      stdout: app.supervisorOutput,
      stderr: null,
      get exitCode() {
        return supervisor.exitCode
      },
      get signalCode() {
        return supervisor.signalCode
      },
    })
  } catch (error) {
    clearTimeout(startupTimer)
    rejectReady(error)
    rejectFinished(error)
    supervisor.kill('SIGKILL')
  }
  return ready
}
