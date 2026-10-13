import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { summarizeCoreCpuProfile } from '../dsh/electron-host/cpu-profile-summary.js'
export { summarizeCoreCpuProfile } from '../dsh/electron-host/cpu-profile-summary.js'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const profile = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const startupEndTimeUs = process.argv[3] === undefined ? undefined : Number(process.argv[3])
    console.log(JSON.stringify(summarizeCoreCpuProfile(profile, startupEndTimeUs), null, 2))
  } catch {
    console.error('Could not summarize CPU profile')
    process.exitCode = 1
  }
}
