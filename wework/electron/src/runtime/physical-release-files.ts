import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)

// Electron's patched fs sees app.asar as a virtual directory. Do not disable ASAR
// in the running host: concurrent imports and renderer requests must keep working.
// The isolated child operates on physical archives without loading release code.
const SCRIPT = `
(async () => {
  const [operation, source, destination, tarModule] = process.argv.slice(1)
  const tar = operation === 'extract' ? require(tarModule) : null
  process.noAsar = true
  const fs = require('node:fs/promises')
  if (operation === 'copy') await fs.cp(source, destination, {recursive:true,verbatimSymlinks:true})
  else if (operation === 'remove') await fs.rm(source, {recursive:true,force:true})
  else if (operation === 'extract') await tar.extract({file:source,cwd:destination,strict:true})
  else throw new Error('Invalid physical release operation')
})().catch(error => { console.error(error); process.exitCode = 1 })
`

async function physicalOperation(
  operation: 'copy' | 'extract' | 'remove',
  source: string,
  destination = ''
): Promise<void> {
  await execute(
    process.execPath,
    [
      '--input-type=commonjs',
      '--eval',
      SCRIPT,
      operation,
      source,
      destination,
      require.resolve('tar'),
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }
  )
}

export const copyPhysicalRelease = (source: string, destination: string): Promise<void> =>
  physicalOperation('copy', source, destination)
export const extractPhysicalRelease = (source: string, destination: string): Promise<void> =>
  physicalOperation('extract', source, destination)
export const removePhysicalRelease = (source: string): Promise<void> =>
  physicalOperation('remove', source)
