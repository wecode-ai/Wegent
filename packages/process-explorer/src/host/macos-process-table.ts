import { spawn } from 'node:child_process'
import type { SystemProcessInfo } from '../core/build-snapshot.js'
import { resolveProcessName } from './process-name.js'
import {
  describeError,
  type SystemProcessTable,
  type SystemProcessTableResult,
} from './system-process-table.js'

export interface PsOutput {
  /** Pid of the `ps` process itself, which lists its own row. */
  pid: number
  /** Decoded as latin1 so every byte is exactly one character. */
  output: string
}

export type PsReader = () => Promise<PsOutput>

/**
 * `ucomm` is always 16 bytes wide and `args` is last, so `args` can keep its
 * spaces. `comm` is deliberately absent: `systeminformation` guesses where the
 * executable ends inside the command line, which turns `gh api` and URL tails
 * like `Wegent.git` into process names. The kernel-provided `ucomm` is exact.
 */
const PS_COLUMNS = 'pid=,ppid=,pcpu=,rss=,lstart=,ucomm=,args='
/**
 * Everything before `ucomm` is ASCII, so character offsets equal byte offsets.
 * `lstart` is padded past the date, so all spacing up to `ucomm` is consumed here.
 */
const PS_PREFIX =
  /^(\s*\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+/
const UCOMM_BYTES = 16

/** macOS process table read directly from `ps` with explicit columns. */
export class MacosProcessTable implements SystemProcessTable {
  constructor(private readonly readPs: PsReader = runPs) {}

  async read(): Promise<SystemProcessTableResult> {
    let ps: PsOutput
    try {
      ps = await this.readPs()
    } catch (error) {
      return {
        processes: [],
        degraded: [{ code: 'system-process-table-failed', detail: describeError(error) }],
      }
    }

    const processes: SystemProcessInfo[] = []
    let malformed = 0
    for (const line of ps.output.split('\n')) {
      if (!line.trim()) continue
      const row = parsePsLine(line)
      if (!row) {
        malformed++
        continue
      }
      if (row.pid === ps.pid) continue
      processes.push(row)
    }
    // A single unexpected row must not hide the whole table; only an output
    // format that yields nothing is a failed read.
    if (processes.length === 0 && malformed > 0) {
      return {
        processes: [],
        degraded: [
          {
            code: 'system-process-table-failed',
            detail: `${malformed} ps ${malformed === 1 ? 'line' : 'lines'} could not be parsed`,
          },
        ],
      }
    }
    return { processes, degraded: [] }
  }
}

/** Parses one `ps` line in `PS_COLUMNS` order. */
export function parsePsLine(line: string): SystemProcessInfo | null {
  const prefix = PS_PREFIX.exec(line)
  if (!prefix) return null
  // `ps` pads and truncates `ucomm` by bytes, possibly in the middle of a
  // multi-byte character, so the boundary is found before decoding.
  const tail = Buffer.from(line.slice(prefix[0].length), 'latin1')
  if (tail.length < UCOMM_BYTES || (tail.length > UCOMM_BYTES && tail[UCOMM_BYTES] !== 0x20)) {
    return null
  }
  const ucomm = decodeName(tail.subarray(0, UCOMM_BYTES)).trimEnd()
  const command =
    tail.length > UCOMM_BYTES
      ? tail
          .subarray(UCOMM_BYTES + 1)
          .toString('utf8')
          .trim()
      : ''
  const [, pid, parentPid, cpu, rss, started] = prefix
  return {
    pid: Number(pid),
    parentPid: Number(parentPid),
    name: resolveProcessName(command, ucomm),
    command: command || null,
    cpuPercent: Number(cpu),
    // `rss` is reported in KiB.
    memoryBytes: Number(rss) * 1024,
    startedAt: parseLstart(started),
    identity: started,
  }
}

function decodeName(bytes: Buffer): string {
  // Drop the replacement character left by a name truncated mid-character.
  return bytes.toString('utf8').replace(/\uFFFD$/, '')
}

/** `lstart` is `Thu Nov 12 01:34:32 2026` in local time. */
function parseLstart(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function runPs(): Promise<PsOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('ps', ['-axo', PS_COLUMNS], { env: psEnvironment() })
    const chunks: Buffer[] = []
    let errors = ''
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      errors += chunk
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0 && child.pid !== undefined) {
        resolve({ pid: child.pid, output: Buffer.concat(chunks).toString('latin1') })
      } else reject(new Error(`ps exited with code ${code}: ${errors.trim()}`))
    })
  })
}

/**
 * English month names keep `lstart` parseable, while a UTF-8 character type
 * keeps non-ASCII command lines readable. `LC_ALL=C` would print them as
 * `M-x` escapes.
 */
function psEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.LC_ALL
  environment.LC_TIME = 'C'
  environment.LC_CTYPE = 'UTF-8'
  return environment
}
