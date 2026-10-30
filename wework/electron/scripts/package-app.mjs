import { packager } from '@electron/packager'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'

import { electronToolchainLockPath } from '../../scripts/lib/electron-toolchain-lock.mjs'
import { prepareSharedElectronZip } from '../../scripts/lib/electron-zip-cache.mjs'
import { acquireProcessLock } from '../../scripts/lib/process-lock.mjs'
import identityModule from './build-identity.cjs'
import builderConfig from '../electron-builder.config.cjs'
import macosAppIcon from './macos-app-icon.cjs'
import { wrapWindowsScriptCommand } from '../../scripts/child-process-command.mjs'

// Electron-as-Node otherwise treats app.asar as a virtual directory during cleanup.
process.noAsar = true

const { resolveBuildIdentity } = identityModule
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const staging = join(electronRoot, '.package-staging')
const sharedResourcesRoot = join(electronRoot, '..', 'resources')
const repositoryRoot = resolve(electronRoot, '..', '..')
const sourcePackage = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'))
// Regression fixtures are independently packaged and signed. Never rewrite a built archive.
const fixtureVersion = process.env.WEWORK_UPGRADE_FIXTURE_VERSION?.trim()
const thinFixture = fixtureVersion && process.env.WEWORK_UPGRADE_FIXTURE_THIN_SOURCE === '1'
const output = fixtureVersion
  ? join(
      resolve(
        process.env.WEWORK_UPGRADE_FIXTURE_OUTPUT ||
          join(electronRoot, '..', 'test-results', 'upgrade-fixtures')
      ),
      'packaged'
    )
  : join(electronRoot, 'release')
const fixtureDataSchema = Number(process.env.WEWORK_UPGRADE_FIXTURE_DATA_SCHEMA || 1)
if (fixtureVersion && !/^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/.test(fixtureVersion))
  throw new Error('Invalid upgrade fixture version')
if (!Number.isSafeInteger(fixtureDataSchema) || fixtureDataSchema < 1)
  throw new Error('Invalid upgrade fixture data schema')
const packageVersion = fixtureVersion || sourcePackage.version
const identity = resolveBuildIdentity()
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const icon =
  process.platform === 'darwin'
    ? macosAppIcon.icon
    : process.platform === 'win32'
      ? join(sharedResourcesRoot, 'icons', 'icon.ico')
      : undefined

await macosAppIcon.prepare({ electronPlatformName: process.platform })
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
      productName: identity.productName,
      version: packageVersion,
      weworkUpgradeFixture: Boolean(fixtureVersion),
      type: sourcePackage.type,
      main: sourcePackage.main,
      dependencies: sourcePackage.dependencies,
      ...builderConfig.extraMetadata,
      ...(fixtureVersion
        ? {
            weworkDataSchema: fixtureDataSchema,
            weworkReadableDataSchemas: Array.from(
              { length: fixtureDataSchema },
              (_, index) => index + 1
            ),
          }
        : {}),
    },
    null,
    2
  )}\n`
)
const releaseToolchainLock = await acquireProcessLock(electronToolchainLockPath)
let applications
try {
  const electronZipDir = await prepareSharedElectronZip({
    electronPackageRoot: join(electronRoot, 'node_modules', 'electron'),
  })
  applications = await packager({
    dir: staging,
    name: identity.productName,
    electronVersion: sourcePackage.devDependencies.electron,
    electronZipDir,
    appBundleId: identity.identifier,
    ...(process.platform === 'darwin' ? { extendInfo: macosAppIcon.extendInfo } : {}),
    protocols: [{ name: 'Wework', schemes: ['wework'] }],
    appVersion: packageVersion,
    buildVersion: packageVersion,
    executableName: identity.executableName,
    out: output,
    overwrite: true,
    asar: {
      unpack: '**/*.{node,dylib,so,dll}',
    },
    extraResource: [
      join(
        electronRoot,
        'resources',
        `wework-launcher${process.platform === 'win32' ? '.exe' : ''}`
      ),
      ...(process.platform === 'darwin' ? [macosAppIcon.assetCatalog] : []),
      ...(thinFixture
        ? []
        : [
            join(electronRoot, 'resources', 'harness-runtime'),
            join(electronRoot, 'resources', 'bin'),
            join(electronRoot, 'resources', 'codex'),
            join(electronRoot, 'resources', 'wework-core-plugins'),
            join(electronRoot, 'resources', 'wework-app-static'),
            join(electronRoot, 'resources', 'bundled-plugins'),
          ]),
      join(electronRoot, 'resources', 'components.json'),
      join(sharedResourcesRoot, 'licenses'),
      join(sharedResourcesRoot, 'icons'),
      join(repositoryRoot, 'LICENSE'),
    ],
    icon,
    prune: false,
  })

  for (const application of applications) {
    const resources =
      process.platform === 'darwin'
        ? join(application, `${identity.productName}.app`, 'Contents', 'Resources')
        : join(application, 'resources')
    if (fixtureVersion) {
      if (thinFixture && process.platform === 'win32') {
        await mkdir(join(resources, 'bin'), { recursive: true })
        await cp(
          join(electronRoot, 'resources', 'bin', 'wegent-executor.exe'),
          join(resources, 'bin', 'wegent-executor.exe')
        )
      }
      const path = join(resources, 'components.json')
      const components = JSON.parse(await readFile(path, 'utf8'))
      components.appVersion = packageVersion
      components.dataSchema = fixtureDataSchema
      components.readableDataSchemas = Array.from(
        { length: fixtureDataSchema },
        (_, index) => index + 1
      )
      await writeFile(path, JSON.stringify(components, null, 2) + '\n')
    }
    await writeFile(
      join(resources, 'app-update.yml'),
      stringify({
        ...builderConfig.publish,
        updaterCacheDirName: `${identity.packageName.toLowerCase()}-updater`,
      })
    )
  }

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
