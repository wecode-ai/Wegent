import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyStartupGdbContract } from './startup-gdb-probe.mjs'

test(
  'real Linux GDB preserves normal, trap, interrupt, and cleanup gates',
  { skip: process.platform !== 'linux' },
  async () => {
    const resultDir = await mkdtemp(join(tmpdir(), 'wework-startup-gdb-contract-'))
    try {
      await verifyStartupGdbContract({ resultDir })
    } finally {
      await rm(resultDir, { recursive: true, force: true })
    }
  }
)
