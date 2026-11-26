import { spawn } from 'node:child_process'
import type { SystemProcessInfo } from '../core/build-snapshot.js'
import {
  describeError,
  type SystemProcessTable,
  type SystemProcessTableResult,
} from './system-process-table.js'
import { resolveProcessName } from './process-name.js'

export interface PsOutput {
  /** Pid of the `ps` process itself, which lists its own row. */
  pid: number
  output: string
}

export type PsReader = () => Promise<PsOutput>

/**
 * `ucomm` is always 16 characters wide and `args` is last, so `args` can keep
 * its spaces. `comm` is deliberately absent: `systeminformation` guesses where the
 * executable ends inside the command line, which turns `gh api` and URL tails
 * like `Wegent.git` into process names. The kernel-provided `ucomm` is exact.
 */
const PS_COLUMNS = 'pid=,ppid=,pcpu=,rss=,lstart=,ucomm=,args='
const PS_LINE =
  /^(\s*\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.{16}) (.*)$/

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
    return {
      processes,
      degraded: malformed
        ? [
            {
              code: 'system-process-table-failed',
              detail: `${malformed} ps ${malformed === 1 ? 'line' : 'lines'} could not be parsed`,
            },
          ]
        : [],
    }
  }
}

/** Parses one `ps` line in `PS_COLUMNS` order. */
export function parsePsLine(line: string): SystemProcessInfo | null {
  const match = PS_LINE.exec(line)
  if (!match) return null
  const [, pid, parentPid, cpu, rss, started, ucomm, args] = match
  const command = args.trim()
  return {
    pid: Number(pid),
    parentPid: Number(parentPid),
    name: resolveProcessName(command, ucomm.trim()),
    command: command || null,
    cpuPercent: Number(cpu),
    // `rss` is reported in KiB.
    memoryBytes: Number(rss) * 1024,
    startedAt: parseLstart(started),
    identity: started,
  }
}

function parseLstart(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function runPs(): Promise<PsOutput> {
  return new Promise((resolve, reject) => {
    // `LC_ALL=C` keeps month names English regardless of the user's locale.
    const child = spawn('ps', ['-axo', PS_COLUMNS], {
      env: { ...process.env, LC_ALL: 'C' },
    })
    let output = ''
    let errors = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      errors += chunk
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0 && child.pid !== undefined) resolve({ pid: child.pid, output })
      else reject(new Error(`ps exited with code ${code}: ${errors.trim()}`))
    })
  })
}
