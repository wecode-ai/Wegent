import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { wrapWindowsScriptCommand } from '../../../scripts/child-process-command.mjs'

import { managedPythonPath, waitForPythonRuntimeEvent } from './managed-python.mjs'
import { CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID } from './shared.mjs'

const run = promisify(execFile)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

export async function createNativeAccountFixture(resultDir, pluginRoot) {
  const buildRoot = join(resultDir, 'native-account-build')
  await mkdir(buildRoot, { recursive: true })
  await copyFile(
    join(repository, 'wework/e2e/desktop/fixtures/native-account-auth/main.go'),
    join(buildRoot, 'main.go')
  )
  await writeFile(
    join(buildRoot, 'go.mod'),
    `module wegent-e2e-native-account\n\ngo 1.23\n\nrequire github.com/wegent/plugin-auth-go v0.0.0\nreplace github.com/wegent/plugin-auth-go => ${JSON.stringify(join(repository, 'sdk/plugin-auth-go').replaceAll('\\', '/'))}\n`
  )
  const binaryName = process.platform === 'win32' ? 'native-account.exe' : 'native-account'
  const build = wrapWindowsScriptCommand('go', [
    'build',
    '-buildvcs=false',
    '-o',
    join(pluginRoot, 'scripts', binaryName),
    '.',
  ])
  await run(build.command, build.args, {
    cwd: buildRoot,
    env: {
      ...process.env,
      GOWORK: 'off',
      GOTOOLCHAIN: 'local',
      CGO_ENABLED: '0',
      GOOS: { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform],
      GOARCH: { arm64: 'arm64', x64: 'amd64' }[process.arch],
    },
    timeout: 5 * 60_000,
  })
  await writeFile(
    join(pluginRoot, 'scripts/native-auth.mjs'),
    `import { spawnSync } from 'node:child_process'\nimport { fileURLToPath } from 'node:url'\nconst result = spawnSync(fileURLToPath(new URL('./${binaryName}', import.meta.url)), process.argv.slice(2), { stdio: 'inherit', env: process.env })\nprocess.exit(result.status ?? 1)\n`
  )
}

export async function verifyNativeAccountRuntimeIsolation({
  api,
  connectionFor,
  electronUserDataDirectory,
  homePath,
  resultDir,
  restartDesktopApp,
  signalAutomaticRetry,
  timeoutMs,
  waitForValue,
  secret,
}) {
  const pythonPath = managedPythonPath(electronUserDataDirectory)
  const backup = `${pythonPath}.mixed-runtime-backup`
  const source = join(homePath, 'native-account-source.json')
  const appLog = join(resultDir, 'app.log')
  let logOffset
  await restartDesktopApp({
    afterStop: async () => {
      await rename(pythonPath, backup)
      await mkdir(pythonPath)
      logOffset = (await readFile(appLog, 'utf8')).length
    },
  })
  try {
    await signalAutomaticRetry()
    await waitForPythonRuntimeEvent(appLog, 'python-runtime-install-failed', logOffset)
    await writeFile(
      source,
      JSON.stringify({
        account: 'native@example.test',
        access_token: secret,
        refresh_token: secret,
        expires_at: Date.now() / 1000 + 3600,
      }),
      { mode: 0o600 }
    )
    await signalAutomaticRetry()
    const native = await waitForValue(
      () => connectionFor('native'),
      value =>
        value?.status === 'connected' &&
        [CLOUD_DEVICE_ID, REMOTE_DOCKER_DEVICE_ID].every(id => value.device_ids.includes(id)),
      timeoutMs,
      'An unrelated Python installation failure blocked the native provider enrollment'
    )
    await rm(source)
    await api(`/plugin-connections/${native.id}`, 'DELETE', { expected_revision: native.revision })
    await waitForValue(
      () => connectionFor('native'),
      value => value?.provider_revocation === 'revoked',
      timeoutMs,
      'An unrelated Python installation failure blocked the native provider revocation'
    )
    assert.equal(await readFile(join(homePath, 'native-account-revoked'), 'utf8'), 'revoked')
    await writeFile(
      join(resultDir, 'mixed-runtime-isolation.json'),
      JSON.stringify(
        { nativeEnrolled: true, nativeRevoked: true, pythonInstallationFailed: true },
        null,
        2
      )
    )
  } finally {
    await rm(source, { force: true })
    // Stop all uv children before restoring the launcher's path.
    await restartDesktopApp({
      afterStop: async () => {
        await rm(pythonPath, { recursive: true, force: true })
        await rename(backup, pythonPath)
      },
    })
  }
}
