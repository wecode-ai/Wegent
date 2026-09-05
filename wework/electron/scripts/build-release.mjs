import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import nodeRuntimeModule from './node-runtime.cjs'

const { resolveNodeRuntime } = nodeRuntimeModule
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronBuilderCli = resolve(electronRoot, 'node_modules/electron-builder/cli.js')
const nodeRuntime = resolveNodeRuntime()
const requestedPlatform = process.env.WEWORK_RELEASE_PLATFORM?.trim()
const requestedArch = process.env.WEWORK_RELEASE_ARCH?.trim()
const directoryOnly = process.env.WEWORK_RELEASE_DIR_ONLY?.trim().toLowerCase() === 'true'
const platform = requestedPlatform || process.platform
const arch = requestedArch || process.arch
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
  nodeRuntime,
  [
    electronBuilderCli,
    '--config',
    'electron-builder.config.cjs',
    platformFlag,
    `--${arch}`,
    ...(directoryOnly ? ['--dir'] : []),
    '--publish',
    'never',
  ],
  electronRoot
)

if (!directoryOnly)
  await run(
    nodeRuntime,
    [
      electronBuilderCli,
      '--config',
      'electron-builder.config.cjs',
      platformFlag,
      `--${arch}`,
      '--publish',
      'never',
    ],
    electronRoot,
    {
      WEWORK_ONLINE_UPDATE_BUILD: 'true',
    }
  )

function run(command, args, cwd, environment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}
