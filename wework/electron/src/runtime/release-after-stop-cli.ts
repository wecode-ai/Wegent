import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareStoppedReleaseData } from './release-after-stop-target.js'

try {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1' || !process.versions.electron)
    throw new Error('Stopped preparation requires the delivered Electron Node runtime')
  const metadata = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  )
  const result = await prepareStoppedReleaseData(
    process.argv[2],
    resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
    metadata
  )
  process.stdout.write(JSON.stringify(result))
} catch {
  // Never propagate private rollout or credential-path diagnostics to the bridge.
  console.error('[release-after-stop] Target data preparation did not complete')
  process.exitCode = 1
}
