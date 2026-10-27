import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portableDesktopRelease } from './lib/portable-desktop-release.mjs'
import { wrapWindowsScriptCommand } from './child-process-command.mjs'
import { UPGRADE_SUITE_VERSION } from '../e2e/desktop/upgrade-suite.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(
  process.env.WEWORK_UPGRADE_FIXTURE_OUTPUT || join(root, 'test-results', 'upgrade-fixtures')
)
const metadata = JSON.parse(await readFile(join(root, 'electron', 'package.json'), 'utf8'))
const sourceVersion = metadata.version
const targetVersion = sourceVersion.includes('-beta.')
  ? sourceVersion.replace(/-beta\.(\d+)$/, (_, n) => `-beta.${Number(n) + 1}`)
  : sourceVersion.replace(/\.(\d+)$/, (_, n) => `.${Number(n) + 1}`)
const platform =
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
const packageDirectory = join(output, 'packaged', `WeWork-${process.platform}-${process.arch}`)
const buildApplication =
  platform === 'macos' ? join(packageDirectory, 'WeWork.app') : packageDirectory
await mkdir(output, { recursive: true })
await rm(join(output, 'pair.json'), { force: true })
const builds = []
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
// Use one prepared dependency set, then independently package each version from source.
for (const [version, dataSchema] of [
  [sourceVersion, 1],
  [targetVersion, 2],
]) {
  await run(pnpmCommand, ['--dir', 'electron', 'run', 'build'], root)
  await run(process.execPath, ['scripts/package-app.mjs'], join(root, 'electron'), {
    WEWORK_UPGRADE_FIXTURE_VERSION: version,
    WEWORK_UPGRADE_FIXTURE_DATA_SCHEMA: String(dataSchema),
    WEWORK_UPGRADE_FIXTURE_OUTPUT: output,
  })
  const destination = join(output, version, platform === 'macos' ? 'WeWork.app' : 'application')
  await rm(destination, { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true })
  await cp(buildApplication, destination, { recursive: true, verbatimSymlinks: true })
  const asset = await portableDesktopRelease({
    appRoot: destination,
    version,
    platform,
    arch: process.arch,
    output,
    fixture: true,
  })
  const executable =
    platform === 'macos'
      ? join(destination, 'Contents/MacOS/WeWork')
      : join(destination, platform === 'windows' ? 'WeWork.exe' : 'WeWork')
  const resources =
    platform === 'macos' ? join(destination, 'Contents/Resources') : join(destination, 'resources')
  builds.push({
    ...asset,
    executable,
    executor: join(
      resources,
      'bin',
      platform === 'windows' ? 'wegent-executor.exe' : 'wegent-executor'
    ),
  })
}
const fixture = {
  schemaVersion: 1,
  kind: 'regression',
  suiteVersion: UPGRADE_SUITE_VERSION,
  from: builds[0],
  to: builds[1],
}
const fixturePath = join(output, 'pair.json')
await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + '\n')
const environment = `WEWORK_E2E_APP_BIN=${fixture.from.executable}\nWEWORK_E2E_EXECUTOR_BIN=${fixture.from.executor}\nWEWORK_E2E_UPGRADE_PAIR=${fixturePath}\nWEWORK_E2E_REQUIRE_RELEASE_PACKAGE=1\n`
await writeFile(join(output, 'pair.env'), environment)
if (process.env.GITHUB_ENV) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(process.env.GITHUB_ENV, environment)
}
console.log(JSON.stringify({ fixturePath, environmentFile: join(output, 'pair.env') }))

async function run(command, args, cwd, overrides = {}) {
  const resolved = wrapWindowsScriptCommand(command, args)
  await new Promise((accept, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      env: { ...process.env, ...overrides },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code =>
      code === 0 ? accept() : reject(new Error(`${command} exited: ${code}`))
    )
  })
}
