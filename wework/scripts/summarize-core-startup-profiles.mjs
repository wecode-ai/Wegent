import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeCoreCpuProfile } from './summarize-core-cpu-profile.mjs'

export async function summarizeCoreStartupProfiles(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const profileRoot = join(root, entry.name, 'electron-user-data/dsh-core/.cpu-profile')
    let profiles
    try {
      profiles = (await readdir(profileRoot)).filter(name => name.endsWith('.cpuprofile'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const logsRoot = join(dirname(profileRoot), '../logs')
    const log = await readFile(join(logsRoot, 'dsh-core-runtime.log'), 'utf8')
    const markers = [...log.matchAll(/\[startup\]\[core-dsh-endpoint\]\s*\{([^}]+)\}/g)].map(
      match => ({
        time: Number(match[1].match(/cpuProfileEndTimeUs:\s*(\d+)/)?.[1]),
        processId: Number(match[1].match(/cpuProfileProcessId:\s*(\d+)/)?.[1]),
      })
    )
    if (
      markers.some(marker => !Number.isFinite(marker.time) || !Number.isInteger(marker.processId))
    ) {
      throw new Error('CPU profile startup clock is unavailable')
    }
    const completedProcesses = new Set()
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
        completedProfiles: profiles.length,
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
  } catch {
    console.error('Could not summarize Core startup CPU diagnostics')
    process.exitCode = 1
  }
}
