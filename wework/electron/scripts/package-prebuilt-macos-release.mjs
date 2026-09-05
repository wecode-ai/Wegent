#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import identityModule from './build-identity.cjs'
import nodeRuntimeModule from './node-runtime.cjs'
import releaseVersionModule from './release-version.cjs'

const { resolveBuildIdentity } = identityModule
const { resolveNodeRuntime } = nodeRuntimeModule
const { resolveReleaseVersion } = releaseVersionModule
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronBuilderCli = resolve(electronRoot, 'node_modules/electron-builder/cli.js')
const nodeRuntime = resolveNodeRuntime()
const [requestedAppPath, arch] = process.argv.slice(2)

if (!requestedAppPath || !['arm64', 'x64'].includes(arch)) {
  throw new Error(
    'Usage: package-prebuilt-macos-release.mjs <signed-and-notarized-app-path> <arm64|x64>'
  )
}
if (process.platform !== 'darwin') {
  throw new Error('Prebuilt macOS releases must be packaged on macOS')
}

const appPath = resolve(requestedAppPath)
if (!(await stat(appPath).catch(() => null))?.isDirectory() || !appPath.endsWith('.app')) {
  throw new Error(`Prebuilt macOS application is missing: ${appPath}`)
}
if (!(await stat(electronBuilderCli).catch(() => null))?.isFile()) {
  throw new Error(
    `Missing electron-builder CLI at ${electronBuilderCli}; install the locked Electron workspace first: pnpm --dir ${electronRoot} install --frozen-lockfile`
  )
}

await verifyApplicationIdentity(appPath)
await verifyApplicationResources(appPath)
await run('xcrun', ['stapler', 'validate', appPath], electronRoot)
await run(
  nodeRuntime,
  [
    electronBuilderCli,
    '--config',
    'electron-builder.config.cjs',
    '--mac',
    'dmg',
    'zip',
    `--${arch}`,
    '--prepackaged',
    appPath,
    '--publish',
    'never',
  ],
  electronRoot,
  {
    ...process.env,
    WEWORK_PREPACKAGED_MACOS_RELEASE: 'true',
  }
)
await run(
  nodeRuntime,
  [
    electronBuilderCli,
    '--config',
    'electron-builder.config.cjs',
    '--mac',
    'zip',
    `--${arch}`,
    '--prepackaged',
    appPath,
    '--publish',
    'never',
  ],
  electronRoot,
  {
    ...process.env,
    WEWORK_PREPACKAGED_MACOS_RELEASE: 'true',
    WEWORK_ONLINE_UPDATE_BUILD: 'true',
    WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS: 'true',
  }
)

async function verifyApplicationIdentity(path) {
  const identity = resolveBuildIdentity()
  const packageMetadata = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'))
  const expectedVersion = resolveReleaseVersion(packageMetadata.version)
  const expectedName = `${identity.productName}.app`
  const [identifier, version] = await Promise.all([
    capture('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', infoPath(path)]),
    capture('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', infoPath(path)]),
  ])
  if (basename(path) !== expectedName) {
    throw new Error(`Prebuilt application name must be ${expectedName}: ${path}`)
  }
  if (identifier.trim() !== identity.identifier) {
    throw new Error(`Prebuilt application identifier does not match ${identity.identifier}`)
  }
  if (version.trim() !== expectedVersion) {
    throw new Error(`Prebuilt application version does not match ${expectedVersion}`)
  }
}

async function verifyApplicationResources(path) {
  const updateConfiguration = join(path, 'Contents', 'Resources', 'app-update.yml')
  if (!(await stat(updateConfiguration).catch(() => null))?.isFile()) {
    throw new Error(`Prebuilt application updater configuration is missing: ${updateConfiguration}`)
  }
}

function infoPath(appPath) {
  return join(appPath, 'Contents', 'Info.plist')
}

function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}: ${stderr.trim()}`))
    })
  })
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}
