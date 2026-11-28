import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { writeHeapSnapshot } from 'node:v8'
import { redactLog } from '../runtime/rotating-log.js'
import { redact } from './feedback-bundle-manager.js'
import { profileHotFrames } from './diagnostic-profile-summary.js'

const run = promisify(execFile)
const LOG_TYPES =
  /^(?:wework-main|renderer-startup|runtime-launch|executor-transport|electron-host-transport|dsh-core-runtime|executor|performance|model-loading)\.log(?:\.\d+)?$/
const MAX_LOG_BYTES = 64 * 1024

export class LiveProcessDiagnostics {
  private mainCapture = false

  constructor(
    private readonly root: string,
    private readonly logs: string,
    private readonly processIds: () => { renderer?: number; executor?: number | null }
  ) {}

  async dispatch(input: Record<string, unknown>) {
    if (input.action === 'logs') return this.recentLogs(input.source)
    const processId = this.processFor(input.target)
    if (input.action === 'sample') {
      if (process.platform !== 'darwin')
        throw new Error('Native stack sampling currently requires macOS')
      const directory = await this.directory()
      const samplePath = join(directory, 'threads.sample.txt')
      await run('/usr/bin/sample', [String(processId), '5', '1', '-file', samplePath], {
        timeout: 12_000,
      }).catch(() => {
        throw new Error(
          'Could not sample the selected process. It may have exited or restricted sampling.'
        )
      })
      return { pid: processId, samplePath }
    }
    if (input.action === 'native-memory') {
      if (process.platform !== 'darwin')
        throw new Error('Native memory summaries currently require macOS')
      const directory = await this.directory()
      const memoryPath = join(directory, 'native-memory.txt')
      const { stdout } = await run('/usr/bin/vmmap', ['-summary', String(processId)], {
        timeout: 12_000,
        maxBuffer: 512 * 1024,
      }).catch(() => {
        throw new Error(
          'Could not inspect memory for the selected process. It may have exited or restricted inspection.'
        )
      })
      await writeFile(memoryPath, redact(redactLog(stdout)), { mode: 0o600 })
      return { pid: processId, memoryPath }
    }
    if (input.target !== 'main')
      throw new Error('This collection requires the Electron main process')
    if (this.mainCapture)
      throw new Error('A main-process diagnostics collection is already running')
    this.mainCapture = true
    try {
      const directory = await this.directory()
      if (input.action === 'heap') {
        const heapPath = join(directory, 'main.heapsnapshot')
        writeHeapSnapshot(heapPath)
        return { pid: processId, heapPath }
      }
      const profilePath = join(directory, 'main.cpuprofile')
      const hotFrames = await recordMainProfile(profilePath)
      return { pid: processId, profilePath, hotFrames }
    } finally {
      this.mainCapture = false
    }
  }

  private processFor(target: unknown): number {
    if (target === 'main') return process.pid
    const processes = this.processIds()
    const pid = target === 'renderer' || target === 'executor' ? processes[target] : null
    if (!pid || pid <= 0)
      throw new Error('The selected process is unavailable in this Wework instance')
    return pid
  }

  private async directory() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    return mkdtemp(join(this.root, 'process-'))
  }

  private async recentLogs(source: unknown) {
    const entries = await readdir(this.logs, { withFileTypes: true })
    const sources = entries
      .filter(entry => entry.isFile() && LOG_TYPES.test(entry.name))
      .map(entry => entry.name)
      .sort()
    if (source === undefined) return { sources }
    if (typeof source !== 'string' || !sources.includes(source))
      throw new Error('Unknown diagnostics log source')
    const handle = await open(join(this.logs, source), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const file = await handle.stat()
      if (!file.isFile()) throw new Error('The diagnostics log is unavailable')
      const { size } = file
      const offset = Math.max(0, size - MAX_LOG_BYTES)
      const buffer = Buffer.alloc(size - offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      const text = buffer.toString('utf8', 0, bytesRead)
      const excerpt = redact(redactLog(offset > 0 ? text.slice(text.indexOf('\n') + 1) : text))
      const logPath = join(await this.directory(), source)
      await writeFile(logPath, excerpt, { mode: 0o600 })
      return {
        source,
        logPath,
        truncated: offset > 0 || excerpt.length > 3_000,
        text: excerpt.slice(-3_000),
      }
    } finally {
      await handle.close()
    }
  }
}

async function recordMainProfile(path: string) {
  const inspector = new Session()
  inspector.connect()
  try {
    await inspector.post('Profiler.enable')
    await inspector.post('Profiler.start')
    await delay(10_000)
    const { profile } = await inspector.post('Profiler.stop')
    await writeFile(path, JSON.stringify(profile), { mode: 0o600 })
    return profileHotFrames(profile)
  } finally {
    inspector.disconnect()
  }
}
