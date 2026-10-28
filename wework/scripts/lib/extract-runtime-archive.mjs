import { execFile } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Shared runners consume build artifacts without installing workspace packages. */
export async function extractRuntimeArchive(archive, destination) {
  const path = resolve(archive)
  // GNU tar treats a drive letter in its archive operand as a remote host.
  // Resolve that operand from its directory; -C accepts the destination path.
  await execute('tar', ['-xzf', `./${basename(path)}`, '-C', resolve(destination)], {
    cwd: dirname(path),
    timeout: 300_000,
    windowsHide: true,
  })
}
