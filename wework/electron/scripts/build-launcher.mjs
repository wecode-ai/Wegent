import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function buildLauncher(
  resources,
  target,
  source = join(root, '..', 'launcher', 'src', 'main.rs')
) {
  await mkdir(resources, { recursive: true })
  const windowsTarget = target.includes('windows')
  const output = join(resources, `wework-launcher${windowsTarget ? '.exe' : ''}`)
  // Cargo's target linker setting is not read by direct rustc invocations.
  const linker = process.env[`CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`]
  await execute('rustc', [
    '--edition',
    '2021',
    '--target',
    target,
    ...(linker !== undefined ? ['-C', `linker=${linker}`] : []),
    // The launcher starts before any redistributable could be installed.
    ...(windowsTarget ? ['-C', 'target-feature=+crt-static'] : []),
    '-O',
    source,
    '-o',
    output,
  ])
  return output
}
