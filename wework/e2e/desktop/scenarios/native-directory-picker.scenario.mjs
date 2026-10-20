import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createNativeDialogDriver } from '../modules/native-dialog-driver.mjs'
import { withTimeout } from '../modules/shared.mjs'

const PICKER_HOLD_MS = 125_000
const PROJECT_BUTTON = '[data-testid="project-work-button"]'
const CREATE_DIALOG = '[data-testid="local-project-create-dialog"]'
const PICKER_ERROR = '[data-testid="standalone-folder-native-error-dialog"]'

async function assertNoPickerError(control) {
  assert.equal(await control.command('getElementCount', PICKER_ERROR), '0')
}

async function readHostPid(registryDirectory) {
  const records = await Promise.all(
    (await readdir(registryDirectory))
      .filter(name => name.endsWith('.json'))
      .map(async name => JSON.parse(await readFile(join(registryDirectory, name), 'utf8')))
  )
  const hosts = records.filter(record => record.instanceKind === 'main')
  assert.equal(hosts.length, 1, 'The isolated application must publish exactly one main host')
  assert.ok(Number.isSafeInteger(hosts[0].pid) && hosts[0].pid > 0)
  return hosts[0].pid
}

async function openPicker(control, native) {
  const previousWindows = await native.windows()
  await control.command('waitFor', PROJECT_BUTTON, { enabled: true })
  await control.command('click', PROJECT_BUTTON)
  await control.command('click', '[data-testid="add-local-project-option"]')
  const windowId = await native.waitForDialog(previousWindows)
  assert.equal(
    await control.command('getElementCount', '[data-testid="device-folder-path-input"]'),
    '0',
    'The creation entry used the in-app picker instead of the native host capability'
  )
  return windowId
}

async function holdPicker(control, native, windowId, evidenceName) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < PICKER_HOLD_MS) {
    await delay(Math.min(30_000, PICKER_HOLD_MS - (Date.now() - startedAt)))
    await assertNoPickerError(control)
    assert.ok(
      (await native.windows()).some(window => window.window_id === windowId),
      'The native directory picker closed before the user responded'
    )
    console.log(`[native-directory-picker] ${evidenceName}: waited ${Date.now() - startedAt}ms`)
  }
  await native.snapshot(windowId, evidenceName)
  return Date.now() - startedAt
}

async function completeProject(control, path, name, timeoutMs) {
  await control.command('waitFor', CREATE_DIALOG)
  const selectedPath = await control.command(
    'getAttribute',
    '[data-testid="local-project-create-root-0"] span',
    { value: 'title' }
  )
  assert.equal(
    await realpath(selectedPath),
    await realpath(path),
    'The native directory selection did not reach the real creation form'
  )
  await control.command('fill', '[data-testid="local-project-create-name-input"]', { value: name })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]')
  await control.command('waitFor', PROJECT_BUTTON, { text: name, timeoutMs })
  await assertNoPickerError(control)
}

export function createDesktopScenario({
  captureScreenshot,
  executorHome,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  workspacePath,
}) {
  const registryDirectory = join(executorHome, 'runtime', 'native-dialog-instances')
  let native
  let requestController
  let restartDesktopApp
  const evidence = {}

  return {
    appEnvironment: {
      WEWORK_DESKTOP_CONTROL_REGISTRY_DIR: registryDirectory,
      WEWORK_E2E_BACKGROUND_WINDOW: '0',
      WEWORK_E2E_NATIVE_DIRECTORY_PICKER: 'true',
      WEWORK_E2E_OPEN_DIALOG_PATH: '',
    },

    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },

    async verify(control) {
      assert.equal(typeof restartDesktopApp, 'function')
      await control.command('waitFor', PROJECT_BUTTON, { timeoutMs: workbenchReadyTimeoutMs })
      const hostPid = await readHostPid(registryDirectory)
      native = await createNativeDialogDriver({
        pid: hostPid,
        resultDir,
        timeoutMs: uiTimeoutMs,
      })
      const selectedPath = join(workspacePath, 'native-picker-selected')
      const recoveryPath = join(workspacePath, 'native-picker-after-cancel')
      await Promise.all([
        mkdir(selectedPath, { recursive: true }),
        mkdir(recoveryPath, { recursive: true }),
      ])

      const selectionWindow = await openPicker(control, native)
      evidence.selectedAfterMs = await holdPicker(
        control,
        native,
        selectionWindow,
        'native-picker-held-before-selection'
      )
      await native.selectDirectory(selectionWindow, selectedPath)
      await completeProject(
        control,
        selectedPath,
        'Native picker selected',
        workbenchReadyTimeoutMs
      )
      await captureScreenshot(control, 'native-picker-project-created.png', 'body')

      const cancelWindow = await openPicker(control, native)
      evidence.canceledAfterMs = await holdPicker(
        control,
        native,
        cancelWindow,
        'native-picker-held-before-cancel'
      )
      await native.cancel(cancelWindow)
      await control.command('waitFor', PROJECT_BUTTON, { enabled: true })
      assert.equal(await control.command('getElementCount', CREATE_DIALOG), '0')
      await assertNoPickerError(control)

      const recoveryWindow = await openPicker(control, native)
      await native.selectDirectory(recoveryWindow, recoveryPath)
      await completeProject(
        control,
        recoveryPath,
        'Native picker recovered',
        workbenchReadyTimeoutMs
      )
      await captureScreenshot(control, 'native-picker-cancel-recovered.png', 'body')

      // Stop the actual Electron host with a real native request still in flight.
      const previousWindows = await native.windows()
      const origin = await control.command('getLocationOrigin', 'body')
      requestController = new AbortController()
      const outcome = fetch(`${origin}/wework/electron-host/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capability: 'dialog.open',
          params: { properties: ['openDirectory'] },
        }),
        signal: requestController.signal,
      })
        .then(response => response.json())
        .then(
          payload => ({ payload }),
          error => ({ error })
        )
      let requestSettled = false
      void outcome.then(() => {
        requestSettled = true
      })
      const disconnectWindow = await native.waitForDialog(previousWindows)
      await native.snapshot(disconnectWindow, 'native-picker-before-host-disconnect')
      assert.equal(requestSettled, false, 'The native request failed before the host stopped')
      await native.close()
      native = null

      process.kill(hostPid, 'SIGKILL')
      await restartDesktopApp({
        async afterStop() {
          const result = await withTimeout(
            outcome,
            uiTimeoutMs,
            'The native dialog request remained pending after its Electron host disconnected'
          )
          if (result.error) {
            assert.equal(requestController.signal.aborted, false)
            assert.ok(
              ['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED'].includes(result.error.cause?.code),
              `Unexpected failure after host disconnect: ${result.error.message}`
            )
            evidence.disconnect = { code: result.error.cause.code }
          } else {
            assert.equal(result.payload.ok, false)
            assert.ok(['host_disconnected', 'client_closed'].includes(result.payload.error?.code))
            evidence.disconnect = { code: result.payload.error.code }
          }
        },
      })
      await control.command('waitFor', PROJECT_BUTTON, {
        text: 'Native picker recovered',
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await assertNoPickerError(control)
      await control.command('click', PROJECT_BUTTON)
      await control.command('waitFor', '[data-testid="add-local-project-option"]', {
        enabled: true,
      })
      await control.command('press', 'body', { key: 'Escape' })
      await captureScreenshot(control, 'native-picker-host-restarted.png', 'body')
      await writeFile(
        join(resultDir, 'native-directory-picker.json'),
        `${JSON.stringify(evidence, null, 2)}\n`
      )
    },

    async cleanup() {
      requestController?.abort()
      await native?.close()
    },
  }
}
