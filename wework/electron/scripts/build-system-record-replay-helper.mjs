import { spawn } from 'node:child_process'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(electronRoot, 'resources', 'bin', 'wework-system-record-replay')

if (process.platform !== 'darwin') process.exit(0)

await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await run('xcrun', [
  'swiftc',
  '-O',
  join(electronRoot, 'native', 'system-record-replay', 'main.swift'),
  '-o',
  output,
  '-framework',
  'AppKit',
  '-framework',
  'ApplicationServices',
])
await chmod(output, 0o755)

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: electronRoot, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveRun()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}
