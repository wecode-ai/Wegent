import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function buildLauncher(resources, target) {
  await mkdir(resources, { recursive: true })
  const output = join(resources, `wework-launcher${target.includes('windows') ? '.exe' : ''}`)
  await execute('rustc', [
    '--edition',
    '2021',
    '--target',
    target,
    '-O',
    join(root, '..', 'launcher', 'src', 'main.rs'),
    '-o',
    output,
  ])
  return output
}
