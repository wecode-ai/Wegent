import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { waitForStartupProgressEvidence } from '../modules/startup-splash-progress.mjs'
import { resolveDesktopPackageLayout } from '../modules/desktop-package-layout.mjs'
import {
  createWindowsUpdateScenario,
  createShortInstallRoot,
  readInstallationState,
  runWithoutAsar,
  stopInstallationProcesses,
  waitForInstallationActivation,
} from './windows-update.scenario.mjs'

async function installPackage(installer, installRoot, output) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(installer, ['/S', `/D=${installRoot}`], {
      // NSIS requires /D last and unquoted, including directory names with spaces.
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => output.push(chunk.toString()))
    child.stderr.on('data', chunk => output.push(chunk.toString()))
    child.once('error', reject)
    child.once('exit', code =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`Actual NSIS ${basename(installer)} exited with ${code}`))
    )
  })
}

export async function createDesktopScenario(context) {
  assert.equal(process.platform, 'win32', 'Direct NSIS upgrades require real Windows')
  const { electronUserDataDirectory, resultDir } = context
  const legacyInstaller = process.env.WEWORK_E2E_LEGACY_WINDOWS_INSTALLER
  const legacyVersion = process.env.WEWORK_E2E_LEGACY_WINDOWS_VERSION
  const assetsRoot = process.env.WEWORK_E2E_WINDOWS_MIGRATION_ASSETS
  const fixture = JSON.parse(await readFile(process.env.WEWORK_E2E_WINDOWS_UPDATE_FIXTURES, 'utf8'))
  assert.ok(
    legacyInstaller && legacyVersion && assetsRoot,
    'Provide the actual published legacy installer and signed full installer'
  )
  const setup = join(assetsRoot, `WeWork_${fixture.baselineVersion}_windows_x64-setup.exe`)
  const hash = createHash('sha512')
  await pipeline(createReadStream(setup), hash)
  const installerSha512 = hash.digest('base64')
  const installRoot = createShortInstallRoot()
  const output = []
  await installPackage(resolve(legacyInstaller), installRoot, output)
  await stopInstallationProcesses(installRoot)
  const replacements = []
  const scenario = await createWindowsUpdateScenario(context, {
    installRoot,
    existingInstallation: true,
    async beforeUpdate(control, { restartDesktopApp, assertUserData }) {
      await control.command('navigate', 'body', { value: '/settings/about' })
      await control.command('waitFor', '[data-testid="about-app-version"]', { text: legacyVersion })
      for (const pass of ['legacy-to-v2', 'v2-over-v2']) {
        const before = pass === 'v2-over-v2' ? await readInstallationState(installRoot) : null
        const directories = before ? await readdir(join(installRoot, 'versions')) : []
        const logBytes = await stat(join(electronUserDataDirectory, 'logs', 'wework-main.log'))
          .then(value => value.size)
          .catch(error => {
            if (error.code === 'ENOENT') return 0
            throw error
          })
        await stopInstallationProcesses(installRoot)
        await restartDesktopApp({
          afterStop: async () => {
            await installPackage(setup, installRoot, output)
            await stopInstallationProcesses(installRoot)
          },
        })
        const state = await waitForInstallationActivation(installRoot, fixture.baselineVersion)
        assert.equal(state.active.version, fixture.baselineVersion)
        assert.equal(state.candidate, undefined)
        if (before) {
          assert.deepEqual(
            state,
            before,
            'Reinstalling a full package changed the active version state'
          )
          const after = await readdir(join(installRoot, 'versions'))
          for (const directory of directories) {
            assert.ok(
              after.includes(directory),
              `Direct reinstall deleted immutable version ${directory}`
            )
          }
        }
        await assertUserData(control)
        const startup = await waitForStartupProgressEvidence({
          userDataDirectory: electronUserDataDirectory,
          resultDir,
          afterBytes: logBytes,
          name: `windows-reinstall-${pass}-startup`,
        })
        replacements.push({
          pass,
          active: state.active,
          preservedVersions: directories,
          startupStages: startup.stages,
        })
        if (pass === 'legacy-to-v2') {
          // Preserve a real inactive complete release, not just the active version
          // that the same full installer would recreate after destructive removal.
          const inactive = await resolveDesktopPackageLayout(
            join(fixture.artifacts.target.installRoot, 'WeWork.exe')
          )
          await runWithoutAsar(() =>
            cp(dirname(inactive.versionBinary), join(installRoot, inactive.state.active.path), {
              recursive: true,
            })
          )
        }
      }
    },
  })
  const cleanup = scenario.cleanup
  scenario.cleanup = async () => {
    try {
      await cleanup()
    } finally {
      await writeFile(join(resultDir, 'windows-reinstall-nsis.log'), output.join(''))
      await writeFile(
        join(resultDir, 'windows-reinstall-evidence.json'),
        `${JSON.stringify(
          {
            legacyVersion,
            fullInstallerVersion: fixture.baselineVersion,
            nextVersion: fixture.targetVersion,
            installerSha512,
            replacements,
            entry:
              'Actual published legacy NSIS, direct full NSIS overwrite twice, then actual v2 in-app update',
          },
          null,
          2
        )}\n`
      )
    }
  }
  return scenario
}
