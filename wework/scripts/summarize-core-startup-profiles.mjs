import { coreCpuProfileValidationCode } from '../dsh/electron-host/cpu-profile-summary.js'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeCoreCpuProfile } from './summarize-core-cpu-profile.mjs'

export async function summarizeCoreStartupProfiles(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const profileRoot = join(root, entry.name, 'electron-user-data/dsh-core/.cpu-profile')
    const logsRoot = join(dirname(profileRoot), '../logs')
    let logFiles
    try {
      logFiles = await readdir(logsRoot)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    let profiles = []
    try {
      profiles = (await readdir(profileRoot)).filter(name => name.endsWith('.cpuprofile'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!logFiles.includes('dsh-core-runtime.log')) {
      if (
        profiles.length ||
        logFiles.some(name => /^core-startup-cpu-profile-\d+\.json$/.test(name))
      ) {
        throw new Error('Core startup CPU endpoint log is unavailable')
      }
      continue
    }
    const log = await readFile(join(logsRoot, 'dsh-core-runtime.log'), 'utf8')
    const markers = [...log.matchAll(/\[startup\]\[core-dsh-endpoint\]\s*\{([^}]+)\}/g)]
      .filter(match => /cpuProfileEndTimeUs|cpuProfileClockStatus/.test(match[1]))
      .map(match => ({
        time: Number(match[1].match(/cpuProfileEndTimeUs:\s*(\d+)/)?.[1]),
        processId: Number(match[1].match(/cpuProfileProcessId:\s*(\d+)/)?.[1]),
        failureCode: match[1].match(
          /cpuProfileFailureCode:\s*['"](core_profile_(?:stop_failed|summarize_failed|write_failed|unknown_failure|unavailable))['"]/
        )?.[1],
        validationCode: coreCpuProfileValidationCode(
          match[1].match(/cpuProfileValidationCode:\s*['"]([^'"]+)['"]/)?.[1]
        ),
        requiresSummary: /cpuProfileSummaryMode:\s*['"]before-endpoint['"]/.test(match[1]),
      }))
    const failed = markers.find(marker => marker.failureCode)
    if (failed) {
      throw Object.assign(new Error('Core startup CPU diagnostics failed before endpoint'), {
        code: failed.failureCode,
        validationCode: failed.validationCode,
      })
    }
    if (
      markers.some(marker => !Number.isFinite(marker.time) || !Number.isInteger(marker.processId))
    ) {
      throw new Error('CPU profile startup clock is unavailable')
    }
    const completedProcesses = new Set()
    for (const name of logFiles) {
      const processId = Number(name.match(/^core-startup-cpu-profile-(\d+)\.json$/)?.[1])
      if (!Number.isInteger(processId)) continue
      const summary = JSON.parse(await readFile(join(logsRoot, name), 'utf8'))
      if (summary.scope !== 'startup-to-endpoint' || !Number.isFinite(summary.durationMs)) {
        throw new Error('Core startup CPU summary is invalid')
      }
      if (!markers.some(marker => marker.processId === processId)) {
        throw new Error('Core startup CPU summary endpoint is unavailable')
      }
      completedProcesses.add(processId)
    }
    if (
      markers.some(marker => marker.requiresSummary && !completedProcesses.has(marker.processId))
    ) {
      throw new Error('Core startup CPU summary is unavailable before endpoint')
    }
    if (profiles.length === 0 && completedProcesses.size === 0 && markers.length === 0) continue
    for (const [index, name] of profiles.entries()) {
      const processId = Number(name.match(/^CPU\.\d{8}\.\d{6}\.(\d+)\.\d+\.\d+\.cpuprofile$/)?.[1])
      if (!Number.isInteger(processId))
        throw new Error('CPU profile process identity is unavailable')
      const profile = JSON.parse(await readFile(join(profileRoot, name), 'utf8'))
      const matching = markers.filter(
        marker =>
          marker.processId === processId &&
          marker.time > profile.startTime &&
          marker.time <= profile.endTime
      )
      if (matching.length !== 1) throw new Error('CPU profile startup marker is unavailable')
      const summary = summarizeCoreCpuProfile(profile, matching[0].time)
      completedProcesses.add(processId)
      await writeFile(
        join(logsRoot, `core-startup-cpu-summary-${index + 1}.json`),
        `${JSON.stringify(summary, null, 2)}\n`
      )
    }
    // Forced runtime restarts do not flush V8 profiles. Count those separately.
    await writeFile(
      join(logsRoot, 'core-startup-cpu-profile-status.json'),
      `${JSON.stringify({
        completedProfiles: completedProcesses.size,
        endpointProcesses: new Set(markers.map(marker => marker.processId)).size,
        processesWithoutCompletedProfile: new Set(
          markers
            .filter(marker => !completedProcesses.has(marker.processId))
            .map(marker => marker.processId)
        ).size,
      })}\n`
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await summarizeCoreStartupProfiles(process.argv[2])
  } catch (error) {
    const safeErrors = new Set([
      'Core startup CPU endpoint log is unavailable',
      'CPU profile startup clock is unavailable',
      'Core startup CPU diagnostics failed before endpoint',
      'Core startup CPU summary is invalid',
      'Core startup CPU summary endpoint is unavailable',
      'Core startup CPU summary is unavailable before endpoint',
      'CPU profile process identity is unavailable',
      'CPU profile startup marker is unavailable',
      'Invalid CPU profile',
      'Startup marker is outside CPU profile',
    ])
    const reason = safeErrors.has(error.message) ? error.message : 'Diagnostic input is unavailable'
    const failure =
      reason === 'Core startup CPU diagnostics failed before endpoint'
        ? ` (${error.code}${error.validationCode ? `; ${error.validationCode}` : ''})`
        : ''
    console.error(`Could not summarize Core startup CPU diagnostics: ${reason}${failure}`)
    process.exitCode = 1
  }
}
