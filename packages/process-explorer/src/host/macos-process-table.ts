import { spawn } from 'node:child_process'
import type { SystemProcessInfo } from '../core/build-snapshot.js'
import {
  describeError,
  type SystemProcessTable,
  type SystemProcessTableResult,
} from './system-process-table.js'

export interface PsOutput {
  /** Pid of the `ps` process itself, which lists its own row. */
  pid: number
  output: string
}

export type PsReader = () => Promise<PsOutput>

/** `ucomm` and executable names are limited to 16 characters by the kernel. */
const MAX_COMM_LENGTH = 16

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

/**
 * Derives the executable name from the command line and the kernel's
 * `ucomm`. The command line is authoritative when it starts with the
 * executable path, because `ucomm` truncates names longer than 16 characters.
 */
export function resolveProcessName(args: string, ucomm: string): string {
  const trimmed = args.trim()
  const zombie = /^\[(.*)\]$/.exec(trimmed)
  if (zombie) return zombie[1]
  if (!ucomm) return firstWord(trimmed)
  if (!trimmed) return ucomm

  // Find the shortest prefix of the command line whose last path segment is
  // the executable. Paths with spaces resolve at their real boundary because
  // no earlier segment can match `ucomm`.
  let boundary = trimmed.indexOf(' ')
  while (boundary !== -1) {
    const candidate = basename(trimmed.slice(0, boundary))
    if (isExecutableName(candidate, ucomm)) return candidate
    boundary = trimmed.indexOf(' ', boundary + 1)
  }

  // The command line does not start with the executable path (PATH lookup,
  // shell scripts). Its first word is argv[0] when it agrees with `ucomm`.
  const invoked = basename(firstWord(trimmed))
  if (isExecutableName(invoked, ucomm)) return invoked
  // argv[0] was rewritten by the caller; the kernel name is all we know.
  return ucomm
}

function isExecutableName(name: string, ucomm: string): boolean {
  return name === ucomm || (ucomm.length === MAX_COMM_LENGTH && name.startsWith(ucomm))
}

function firstWord(value: string): string {
  return value.split(/\s+/, 1)[0] ?? ''
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** `lstart` is `Thu Nov 12 01:34:32 2026` in local time. */
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
