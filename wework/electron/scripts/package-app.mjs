import { packager } from '@electron/packager'
import { spawn } from 'node:child_process'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { electronToolchainLockPath } from '../../scripts/lib/electron-toolchain-lock.mjs'
import { acquireProcessLock } from '../../scripts/lib/process-lock.mjs'
import identityModule from './build-identity.cjs'
import { wrapWindowsScriptCommand } from '../../scripts/child-process-command.mjs'

// Electron-as-Node otherwise treats app.asar as a virtual directory during cleanup.
process.noAsar = true

const { resolveBuildIdentity } = identityModule
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(electronRoot, 'release')
const staging = join(electronRoot, '.package-staging')
const electronZipDir = process.env.WEWORK_ELECTRON_ZIP_DIR?.trim() || undefined
const sharedResourcesRoot = join(electronRoot, '..', 'resources')
const repositoryRoot = resolve(electronRoot, '..', '..')
const sourcePackage = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'))
const identity = resolveBuildIdentity()
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const icon =
  process.platform === 'darwin'
    ? join(sharedResourcesRoot, 'icons', 'icon.icns')
    : process.platform === 'win32'
      ? join(sharedResourcesRoot, 'icons', 'icon.ico')
      : undefined

await Promise.all([
  rm(output, { recursive: true, force: true }),
  rm(staging, { recursive: true, force: true }),
])
await run(
  pnpmCommand,
  [
    '--config.inject-workspace-packages=true',
    '--config.node-linker=hoisted',
    '--filter',
    sourcePackage.name,
    'deploy',
    '--prod',
    staging,
  ],
  electronRoot
)
await Promise.all(
  ['scripts', 'src', 'pnpm-workspace.yaml', 'tsconfig.json', 'vitest.config.ts'].map(path =>
    rm(join(staging, path), { recursive: true, force: true })
  )
)
await cp(join(electronRoot, 'dist'), join(staging, 'dist'), { recursive: true })
await writeFile(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: sourcePackage.name,
      productName: identity.productName,
      version: sourcePackage.version,
      type: sourcePackage.type,
      main: sourcePackage.main,
      dependencies: sourcePackage.dependencies,
      weworkAppId: identity.identifier,
      ...(identity.executorNamespace
        ? { weworkExecutorNamespace: identity.executorNamespace }
        : {}),
      ...(identity.backendUrl ? { weworkBackendUrl: identity.backendUrl } : {}),
      ...(identity.socketUrl ? { weworkSocketUrl: identity.socketUrl } : {}),
    },
    null,
    2
  )}\n`
)
const releaseToolchainLock = await acquireProcessLock(electronToolchainLockPath)
let applications
try {
  applications = await packager({
    dir: staging,
    name: identity.productName,
    electronVersion: '43.4.1',
    electronZipDir,
    appBundleId: identity.identifier,
    appVersion: sourcePackage.version,
    buildVersion: sourcePackage.version,
    executableName: identity.executableName,
    out: output,
    overwrite: true,
    asar: {
      unpack: '**/*.{node,dylib,so,dll}',
    },
    extraResource: [
      join(electronRoot, 'resources', 'harness-runtime'),
      join(electronRoot, 'resources', 'bin'),
      join(electronRoot, 'resources', 'codex'),
      join(electronRoot, 'resources', 'wework-core-plugins'),
      join(electronRoot, 'resources', 'components.json'),
      join(electronRoot, 'resources', 'bundled-plugins'),
      join(sharedResourcesRoot, 'licenses'),
      join(sharedResourcesRoot, 'icons'),
      join(repositoryRoot, 'LICENSE'),
    ],
    icon,
    prune: false,
  })

  if (process.platform === 'darwin') {
    for (const application of applications) {
      await run(
        'codesign',
        ['--force', '--deep', '--sign', '-', join(application, `${identity.productName}.app`)],
        electronRoot
      )
    }
  }
} finally {
  await releaseToolchainLock()
}

await rm(staging, { recursive: true, force: true })
console.log(JSON.stringify({ applications }, null, 2))

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
