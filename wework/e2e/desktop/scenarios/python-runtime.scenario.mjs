import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertManagedPythonSettings,
  assertPathMissing,
  collectManagedPythonStatus,
  inspectManagedPython,
  managedPythonPath,
  PYTHON_BOOTSTRAP_TIMEOUT_MS,
  waitForPythonRuntimeEvent,
} from '../modules/managed-python.mjs'

export async function createDesktopScenario({
  captureScreenshot,
  electronUserDataDirectory,
  resultDir,
}) {
  const launchDirectory = join(resultDir, 'untrusted-launch-directory')
  const marker = join(resultDir, 'project-python-executed')
  const appLog = join(resultDir, 'app.log')
  const pythonPath = managedPythonPath(electronUserDataDirectory)
  let restartDesktopApp
  const observations = []
  await mkdir(launchDirectory, { recursive: true })
  for (const name of ['ssl', 'ensurepip', 'venv']) {
    await writeFile(
      join(launchDirectory, `${name}.py`),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("untrusted module executed")\nraise RuntimeError("Project code must not run during Python health checks")\n`
    )
  }

  return {
    requiresPackagedHarnessRuntime: true,
    launchWorkingDirectory: launchDirectory,
    appEnvironment: { WEWORK_E2E_DISABLE_PYTHON_BOOTSTRAP: '0' },
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    async prepareApp() {
      await assertPathMissing(pythonPath, 'The cold-start fixture already had a Python launcher')
      await assertPathMissing(
        join(electronUserDataDirectory, 'managed-runtimes', 'python'),
        'The cold-start fixture already had managed Python data'
      )
    },
    async verify(control) {
      // No settings action triggers this first installation: startup owns it.
      try {
        await waitForPythonRuntimeEvent(appLog, 'python-runtime-install-completed')
      } catch (error) {
        try {
          const diagnostic = await collectManagedPythonStatus(control)
          await writeFile(
            join(resultDir, 'python-runtime-startup-failure.json'),
            JSON.stringify(diagnostic, null, 2)
          )
          await captureScreenshot(control, 'python-runtime-startup-failure.png', 'body')
        } catch (diagnosticError) {
          console.error(
            '[desktop-e2e] Python startup diagnostic collection failed:',
            diagnosticError
          )
        }
        throw error
      }
      observations.push({
        phase: 'cold-start',
        ...(await inspectManagedPython(electronUserDataDirectory, launchDirectory)),
      })
      await assertManagedPythonSettings(control, electronUserDataDirectory)
      await assertPathMissing(marker, 'Startup imported a Python module from the project directory')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="execution-environment-python-install"]'
      )
      await assertManagedPythonSettings(control, electronUserDataDirectory)
      await assertPathMissing(marker, 'Refreshing Python health executed project code')
      await captureScreenshot(control, 'python-runtime-cold-installed.png', 'body')

      // A real directory at the launcher's location makes uv's publication fail.
      // Keep the real executable only as a cleanup guard, never substitute a fake Python.
      const backup = `${pythonPath}.e2e-backup`
      let logOffset
      await restartDesktopApp({
        afterStop: async () => {
          await rename(pythonPath, backup)
          await mkdir(pythonPath)
          logOffset = (await readFile(appLog, 'utf8')).length
        },
      })
      try {
        await waitForPythonRuntimeEvent(appLog, 'python-runtime-install-failed', logOffset)
        await control.command('navigate', 'body', { value: '/settings/execution-environments' })
        await control.command('waitFor', '[data-testid="execution-environment-python"]', {
          text: '安装失败',
        })
        await captureScreenshot(control, 'python-runtime-publication-failed.png', 'body')
        await rm(pythonPath, { recursive: true })
        logOffset = (await readFile(appLog, 'utf8')).length
        await control.command(
          'clickWhenEnabled',
          '[data-testid="execution-environment-python-install"]'
        )
        await waitForPythonRuntimeEvent(appLog, 'python-runtime-install-completed', logOffset)
        await control.command('waitFor', '[data-testid="execution-environment-python"]', {
          text: '已安装 · Wework 管理 · 3.12.12',
          timeoutMs: PYTHON_BOOTSTRAP_TIMEOUT_MS,
        })
        observations.push({
          phase: 'retry',
          ...(await inspectManagedPython(electronUserDataDirectory, launchDirectory)),
        })
      } finally {
        await rm(backup, { force: true })
      }
      logOffset = (await readFile(appLog, 'utf8')).length
      await restartDesktopApp()
      await assertManagedPythonSettings(control, electronUserDataDirectory)
      observations.push({
        phase: 'restart',
        ...(await inspectManagedPython(electronUserDataDirectory, launchDirectory)),
      })
      assert.ok(
        !(await readFile(appLog, 'utf8'))
          .slice(logOffset)
          .includes('python-runtime-install-started'),
        'A healthy restart reinstalled Python'
      )
      await assertPathMissing(marker, 'Recovery or restart executed project Python code')
      await captureScreenshot(control, 'python-runtime-recovered-restarted.png', 'body')
      await writeFile(
        join(resultDir, 'python-runtime-verification.json'),
        JSON.stringify(observations, null, 2)
      )
    },
    diagnostics() {
      return { observations, launchDirectory, pythonPath }
    },
  }
}
