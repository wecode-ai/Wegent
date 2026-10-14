import { Session } from 'node:inspector'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { coreCpuProfileValidationCode, summarizeCoreCpuProfile } from './cpu-profile-summary.js'

function inspectorRequest(session, method) {
  return new Promise((resolve, reject) => {
    session.post(method, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

// This module is loaded by --import before the official DSH entry, only for CI diagnostics.
if (process.env.WEWORK_E2E_CORE_CPU_PROFILE === '1') {
  const session = new Session()
  session.connect()
  try {
    await inspectorRequest(session, 'Profiler.enable')
    await inspectorRequest(session, 'Profiler.start')
  } catch {
    session.disconnect()
    throw new Error('Core startup CPU profiler initialization failed')
  }
  let completion
  globalThis[Symbol.for('wework.core.startupCpuProfiler')] = {
    complete() {
      completion ??= completeProfile()
      return completion
    },
  }

  async function completeProfile() {
    let stage = 'stop'
    try {
      const { profile } = await inspectorRequest(session, 'Profiler.stop')
      if (!profile) throw new Error('Core startup CPU profile unavailable')
      stage = 'summarize'
      const summary = summarizeCoreCpuProfile(profile, profile.endTime)
      stage = 'write'
      const logsRoot = join(process.env.DSH_HOME, '../logs')
      mkdirSync(logsRoot, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(logsRoot, `core-startup-cpu-profile-${process.pid}.json`),
        `${JSON.stringify(summary, null, 2)}\n`,
        { mode: 0o600 }
      )
      return {
        cpuProfileEndTimeUs: profile.endTime,
        cpuProfileProcessId: process.pid,
        cpuProfileSummaryMode: 'before-endpoint',
      }
    } catch (error) {
      throw Object.assign(new Error('Core startup CPU diagnostics failed'), {
        code: `core_profile_${stage}_failed`,
        validationCode:
          stage === 'summarize' ? coreCpuProfileValidationCode(error?.code) : undefined,
      })
    } finally {
      session.disconnect()
    }
  }
}
