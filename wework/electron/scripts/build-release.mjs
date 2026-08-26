import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { wrapWindowsScriptCommand } from '../../scripts/child-process-command.mjs'

const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requestedPlatform = process.env.WEWORK_RELEASE_PLATFORM?.trim()
const requestedArch = process.env.WEWORK_RELEASE_ARCH?.trim()
const platform = requestedPlatform || process.platform
const arch = requestedArch || process.arch
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const platformFlag = {
  darwin: '--mac',
  macos: '--mac',
  win32: '--win',
  windows: '--win',
  linux: '--linux',
}[platform]

if (!platformFlag) {
  throw new Error(`Unsupported Wework release platform: ${platform}`)
}
if (!['arm64', 'x64'].includes(arch)) {
  throw new Error(`Unsupported Wework release architecture: ${arch}`)
}

await run(
  pnpmCommand,
  [
    'exec',
    'electron-builder',
    '--config',
    'electron-builder.config.cjs',
    platformFlag,
    `--${arch}`,
    '--publish',
    'never',
  ],
  electronRoot
)

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const resolved = wrapWindowsScriptCommand(command, args)
    const child = spawn(resolved.command, resolved.args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}
