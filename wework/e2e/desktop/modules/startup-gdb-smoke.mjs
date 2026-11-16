import assert from 'node:assert/strict'
import { readFileSync, readSync, writeSync } from 'node:fs'

assert.equal(process.platform, 'linux', 'The startup GDB smoke requires Linux')
const mode = process.argv[2]
assert.ok(['normal', 'trap', 'interrupt'].includes(mode), 'Unknown startup GDB smoke mode')

const stat = readFileSync('/proc/self/stat', 'utf8')
const fields = stat
  .slice(stat.lastIndexOf(')') + 1)
  .trim()
  .split(/\s+/)
writeSync(
  1,
  `[startup-gdb-inferior] ${JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    pgid: Number(fields[2]),
  })}\n`
)

// Only the contract fixture uses FD3: no signal or exit occurs before the
// parent has verified this process's real ownership and acknowledged it.
const acknowledgement = Buffer.alloc(1)
assert.equal(readSync(3, acknowledgement, 0, 1, null), 1, 'Missing GDB smoke acknowledgement')
assert.equal(acknowledgement[0], 1, 'Invalid GDB smoke acknowledgement')
if (mode === 'normal') process.exit(0)
if (mode === 'trap') process.kill(process.pid, 'SIGTRAP')
setInterval(() => {}, 1_000)
