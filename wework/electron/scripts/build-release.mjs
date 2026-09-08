import { prepareSignedComponents } from './prepare-signed-components.mjs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { wrapWindowsScriptCommand } from '../../scripts/child-process-command.mjs'

const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (isMainModule()) {
  await prepareSignedComponents()
  await buildRelease()
}

export async function buildRelease(environment = process.env, runBuild = run) {
  const platform = environment.WEWORK_RELEASE_PLATFORM?.trim() || process.platform
  const arch = environment.WEWORK_RELEASE_ARCH?.trim() || process.arch
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

  const builderArgs = [
    'exec',
    'electron-builder',
    '--config',
    'electron-builder.config.cjs',
    platformFlag,
    `--${arch}`,
    '--publish',
    'never',
  ]
  const builds = releaseBuildEnvironments(environment).map(overrides =>
    runBuild(pnpmCommand, builderArgs, electronRoot, overrides)
  )
  await Promise.all(builds)
}

export function releaseBuildEnvironments(environment = process.env) {
  const buildOnlineUpdate =
    environment.WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS?.trim().toLowerCase() !== 'true'
  return [{}, ...(buildOnlineUpdate ? [{ WEWORK_ONLINE_UPDATE_BUILD: 'true' }] : [])]
}

function isMainModule() {
  const entry = process.argv[1]
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href
}

function run(command, args, cwd, environment = {}) {
  return new Promise((resolvePromise, reject) => {
    const resolved = wrapWindowsScriptCommand(command, args)
    const child = spawn(resolved.command, resolved.args, {
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
