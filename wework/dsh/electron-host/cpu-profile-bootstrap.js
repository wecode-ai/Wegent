import { Session } from 'node:inspector'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarizeCoreCpuProfile } from './cpu-profile-summary.js'

// This module is loaded by --import before the official DSH entry, only for CI diagnostics.
if (process.env.WEWORK_E2E_CORE_CPU_PROFILE === '1') {
  const session = new Session()
  session.connect()
  session.post('Profiler.enable')
  session.post('Profiler.start')
  let completed
  globalThis[Symbol.for('wework.core.startupCpuProfiler')] = {
    complete() {
      if (completed) return completed
      let profile
      let failure
      try {
        session.post('Profiler.stop', (error, result) => {
          failure = error
          profile = result?.profile
        })
        if (failure || !profile) throw new Error('Core startup CPU profile unavailable')
        const summary = summarizeCoreCpuProfile(profile, profile.endTime)
        const logsRoot = join(process.env.DSH_HOME, '../logs')
        mkdirSync(logsRoot, { recursive: true, mode: 0o700 })
        writeFileSync(
          join(logsRoot, `core-startup-cpu-profile-${process.pid}.json`),
          `${JSON.stringify(summary, null, 2)}\n`,
          { mode: 0o600 }
        )
        completed = { cpuProfileEndTimeUs: profile.endTime, cpuProfileProcessId: process.pid }
        return completed
      } finally {
        session.disconnect()
      }
    },
  }
}
