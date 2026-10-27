import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareReleaseEnvironment } from './release-preparation.js'

try {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1' || !process.versions.electron)
    throw new Error('Release preparation requires the delivered Electron Node runtime')
  const metadata = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  )
  await prepareReleaseEnvironment(
    process.argv[2],
    resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
    metadata.version,
    metadata.weworkDataSchema,
    metadata.weworkReadableDataSchemas
  )
} catch (error) {
  console.error(
    '[release-preparation]',
    error instanceof Error ? error.message : 'Preparation failed'
  )
  process.exitCode = 1
}
