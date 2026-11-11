import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { verifyWorkbenchAppColdLaunch } from '../modules/workbench-app-cold-launch.mjs'
import { createWorkbenchAppTaskFixture } from '../modules/workbench-app-task-fixture.mjs'

const NOTE = 'WEWORK_WORKBENCH_PERSISTENT_TODO'
const REMINDER = 'WEWORK_WORKBENCH_BACKGROUND_REMINDER'
const CANCELLED_REMINDER = 'WEWORK_WORKBENCH_CANCELLED_REMINDER'
const STEP_TIMEOUT_MS = 10_000
const execFileAsync = promisify(execFile)
const CLI = fileURLToPath(new URL('../../../electron/src/cli/wework-cli.mjs', import.meta.url))

async function until(read, predicate, description, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let observed
  do {
    let missing = false
    try {
      observed = await read()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      missing = true
      observed = 'The expected file has not been created yet'
    }
    if (!missing && predicate(observed)) return observed
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.fail(`${description}: ${JSON.stringify(observed)}`)
}

function localDateTime(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export async function createDesktopScenario({
  electronUserDataDirectory,
  resultDir,
  restartDesktopApp,
  workspacePath,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let installationId
  const taskFixture = createWorkbenchAppTaskFixture({
    workspacePath,
    electronUserDataDirectory,
    uiTimeoutMs,
    workbenchReadyTimeoutMs,
  })
  const cli = async args => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI, 'workbench', ...args, '--format', 'json'],
      {
        env: {
          ...process.env,
          WEWORK_DESKTOP_CONTROL_REGISTRY_DIR: join(resultDir, 'desktop-control'),
        },
        timeout: workbenchReadyTimeoutMs,
      }
    )
    return JSON.parse(stdout)
  }
  const readRegistry = async () => {
    try {
      return JSON.parse(
        await readFile(
          join(electronUserDataDirectory, 'harness-apps', 'installations.json'),
          'utf8'
        )
      )
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  return {
    appEnvironment: { WEWORK_E2E_BACKGROUND_WINDOW: '0' },
    handleHttp: taskFixture.handleHttp,
    diagnostics: taskFixture.diagnostics,
    async verify(control) {
      const workbenchApp = async (action, options = {}) =>
        JSON.parse(
          await control.command('workbenchApp', 'body', {
            value: JSON.stringify({ action, id: installationId, ...options }),
          })
        )
      const state = () => workbenchApp('snapshot')
      const owned = async () => {
        await control.command('navigate', 'body', { value: '/' })
        await control.command('navigate', 'body', { value: '/sites?app_type=smart_app&view=owned' })
        await control.command('waitFor', '[data-testid="smart-apps-owned-page"]')
      }
      const menu = async action => {
        await control.command(
          'clickWhenEnabled',
          `[data-testid="smart-app-actions-${installationId}"]`
        )
        await control.command('clickWhenEnabled', `[data-testid="${action}-${installationId}"]`)
      }
      const settings = async () => {
        await menu('workbench-settings')
        await control.command('waitFor', '[data-testid="workbench-settings-dialog"]')
      }
      const closeSettings = () =>
        control.command('clickWhenEnabled', '[data-testid="workbench-settings-close"]')
      const reviewInstallation = async choice => {
        await until(
          () => workbenchApp('installation'),
          value => value.visible && value.ready,
          'The trusted installation confirmation did not become ready',
          workbenchReadyTimeoutMs
        )
        assert.deepEqual(await workbenchApp('installation', { choice }), { clicked: true })
      }
      const ready = () =>
        until(
          () => workbenchApp('getText', { selector: '[data-testid="todo-add"]:not([disabled])' }),
          value => Boolean(value),
          'The TODO editor did not finish loading persisted state'
        )
      await owned()
      await control.command('clickWhenEnabled', '[data-testid="workbench-create-todo"]')
      await reviewInstallation('cancel')
      await control.command('waitFor', '[data-testid="workbench-create-todo"]:not([disabled])')
      assert.equal(
        (await readRegistry()).length,
        0,
        'Cancelling installation retained an application or permission grant'
      )
      await control.command('clickWhenEnabled', '[data-testid="workbench-create-todo"]')
      await reviewInstallation('accept')
      await until(
        async () => {
          const installations = (await readRegistry()).filter(app => app.id.startsWith('todo-'))
          assert.ok(installations.length <= 1, 'Created more than one TODO installation')
          if (!installations.length) return null
          assert.equal(installations[0].manifest.flavor, 'lightweight')
          installationId = installations[0].id
          return state()
        },
        value =>
          value?.running && value.visible && value.sdkAvailable && value.presentation === 'window',
        'TODO did not launch an independent DSH window',
        workbenchReadyTimeoutMs
      )
      const article = `[data-testid="smart-app-created-item-${installationId}"]`
      await control.command('waitFor', article)
      assert.equal(
        await control.command('getAttribute', article, { value: 'data-testid' }),
        `smart-app-created-item-${installationId}`
      )
      const input = '[data-testid="todo-input"]'
      await ready()
      await workbenchApp('fill', { selector: input, value: NOTE })
      await workbenchApp('click', { selector: '[data-testid="todo-add"]' })
      await until(
        () => workbenchApp('getText', { selector: '[data-testid="todo-items"]' }),
        value => value?.includes(NOTE),
        'TODO was not rendered'
      )
      const dataPath = join(
        electronUserDataDirectory,
        'harness-apps',
        'instances',
        installationId,
        'wework-app.json'
      )
      const data = async () => JSON.parse(await readFile(dataPath, 'utf8'))
      await until(
        data,
        value => value.state?.[0]?.text === NOTE,
        'TODO was not persisted under its DSH installation'
      )
      await workbenchApp('click', { selector: '[data-testid^="todo-check-"]' })
      await until(
        data,
        value => value.state?.[0]?.done === true,
        'Completing a TODO did not persist its state'
      )

      // Unsaved input and webContents identity must survive both presentation changes.
      await workbenchApp('fill', { selector: input, value: 'unsaved draft' })
      const contentsId = (await state()).contentsId
      for (const presentation of ['tab', 'window']) {
        await cli(['launch', '--id', installationId, '--presentation', presentation])
        const moved = await until(
          state,
          value => value.visible && value.presentation === presentation,
          'Presentation did not change'
        )
        assert.equal(moved.contentsId, contentsId, 'Presentation change created another renderer')
        assert.equal(
          await workbenchApp('getValue', { selector: input }),
          'unsaved draft',
          'Presentation change lost unsaved page state'
        )
      }
      await workbenchApp('fill', { selector: input, value: '' })
      await owned()
      await settings()
      const accelerator = 'CommandOrControl+Alt+Shift+F11'
      const registeredAccelerator = `Alt+${process.platform === 'darwin' ? 'Command' : 'Control'}+Shift+F11`
      await control.command('fill', '[data-testid="workbench-shortcut"]', { value: accelerator })
      await control.command('clickWhenEnabled', '[data-testid="workbench-shortcut-save"]')
      await until(
        readRegistry,
        values => values.find(app => app.id === installationId)?.shortcut === registeredAccelerator,
        'Saving a global shortcut did not persist its binding'
      )
      await closeSettings()
      await control.command('closeMainWindowToTray', 'body')
      await until(
        async () => JSON.parse(await control.command('getNativeWindowState', 'body')),
        value => !value.visible,
        'The main window did not hide'
      )
      assert.equal((await state()).running, true, 'Hiding the main window stopped the application')
      assert.equal(
        (await state()).visible,
        true,
        'Hiding the main window hid the independent application'
      )
      await workbenchApp('close')
      await until(
        state,
        value => value.running && !value.visible,
        'Closing a background-enabled window stopped its DSH runtime'
      )
      await workbenchApp('scheme', { url: `wework://workbenches/${installationId}` })
      await until(
        state,
        value => value.running && value.visible,
        'The native scheme did not reopen the window'
      )
      assert.ok(
        (await workbenchApp('getText', { selector: '[data-testid="todo-items"]' })).includes(NOTE)
      )
      await control.command('restoreMainWindow', 'body')
      await owned()
      const reminderTime = '[data-testid="todo-reminder-time"]'
      await ready()
      await workbenchApp('fill', { selector: input, value: CANCELLED_REMINDER })
      await workbenchApp('fill', {
        selector: reminderTime,
        value: localDateTime(new Date(Date.now() + 3_600_000)),
      })
      await workbenchApp('click', { selector: '[data-testid="todo-add"]' })
      await until(
        data,
        value => value.reminders?.some(item => item.body === CANCELLED_REMINDER),
        'TODO did not persist a scheduled reminder'
      )
      await ready()
      await workbenchApp('fill', { selector: input, value: REMINDER })
      await workbenchApp('fill', {
        selector: reminderTime,
        value: localDateTime(new Date(Date.now() + 15_000)),
      })
      await workbenchApp('click', { selector: '[data-testid="todo-add"]' })
      const scheduled = await until(
        data,
        value => value.reminders?.length === 2,
        'Reminder identities did not persist independently'
      )
      const cancelled = scheduled.state.find(item => item.text === CANCELLED_REMINDER)
      assert.ok(cancelled, 'The cancellation fixture was not saved')
      await workbenchApp('click', { selector: `[data-testid="todo-delete-${cancelled.id}"]` })
      await until(
        data,
        value => value.reminders?.length === 1 && value.reminders[0].body === REMINDER,
        'Cancelling one reminder removed another reminder'
      )
      await menu('smart-app-stop-menu')
      await until(state, value => !value.running, 'Stop did not stop the DSH runtime')
      assert.equal((await data()).reminders[0]?.body, REMINDER, 'Stop lost a durable reminder')
      await until(
        data,
        value => value.reminders.length === 0,
        'The Host did not consume a due reminder after the runtime stopped',
        20_000
      )
      await control.command(
        'clickWhenEnabled',
        `[data-testid="harness-app-start-${installationId}"]`
      )
      await until(
        state,
        value => value.running && value.sdkAvailable,
        'A stopped workbench could not reopen',
        workbenchReadyTimeoutMs
      )
      await until(
        () => workbenchApp('getText', { selector: '[data-testid="todo-items"]' }),
        value => value?.includes(NOTE),
        'Reopening lost the persisted TODO'
      )
      assert.equal((await data()).state[0].done, true)
      await settings()
      await control.command('clickWhenEnabled', '[data-testid="workbench-desktop-shortcut"]')
      const desktopDirectory = join(electronUserDataDirectory, 'e2e-desktop')
      const shortcuts = await until(
        () => readdir(desktopDirectory),
        files => files.some(name => name.startsWith(installationId)),
        'The desktop shortcut was not created'
      )
      const filename = shortcuts.find(name => name.startsWith(installationId))
      const shortcutPath = join(desktopDirectory, filename)
      const shortcutExecutable =
        process.platform === 'darwin' ? join(shortcutPath, 'Contents/MacOS/launch-workbench') : null
      if (shortcutExecutable) {
        assert.equal(filename, `${installationId}.app`)
        const { stdout } = await execFileAsync('/usr/bin/plutil', [
          '-convert',
          'json',
          '-o',
          '-',
          join(shortcutPath, 'Contents/Info.plist'),
        ])
        const manifest = JSON.parse(stdout)
        assert.equal(manifest.CFBundleExecutable, 'launch-workbench')
        assert.equal(manifest.CFBundlePackageType, 'APPL')
        assert.equal(typeof manifest.CFBundleIdentifier, 'string')
        assert.ok((await stat(shortcutExecutable)).mode & 0o100, 'The shortcut is not executable')
        const executable = await readFile(shortcutExecutable, 'utf8')
        assert.ok(executable.includes(`wework://workbenches/${installationId}`))
        assert.ok(
          executable.includes(electronUserDataDirectory),
          'The shortcut lost its owning profile'
        )
      } else {
        assert.ok(
          (await readFile(shortcutPath, 'utf8')).includes(`wework://workbenches/${installationId}`)
        )
      }
      await closeSettings()
      if (shortcutExecutable) {
        const before = await state()
        await cli(['hide', '--id', installationId])
        await until(state, value => !value.visible, 'The shortcut fixture did not hide its view')
        await execFileAsync(shortcutExecutable, [], { timeout: workbenchReadyTimeoutMs })
        const reopened = await until(
          state,
          value => value.running && value.visible && value.sdkAvailable,
          'The desktop shortcut did not reopen its existing workbench',
          workbenchReadyTimeoutMs
        )
        assert.equal(
          reopened.contentsId,
          before.contentsId,
          'The shortcut replaced the running page'
        )
        assert.equal(
          (await data()).state[0].done,
          true,
          'The shortcut lost the existing TODO state'
        )
      }
      await verifyWorkbenchAppColdLaunch({
        control,
        installationId,
        note: NOTE,
        resultDir,
        restartDesktopApp,
        ...(shortcutExecutable ? { shortcutExecutable } : {}),
        startupTimeoutMs: workbenchReadyTimeoutMs,
      })
      assert.equal(
        (await readRegistry()).find(app => app.id === installationId)?.shortcut,
        registeredAccelerator,
        'Cold restart lost the global shortcut'
      )
      await settings()
      await control.command('fill', '[data-testid="workbench-shortcut"]', { value: '' })
      await control.command('clickWhenEnabled', '[data-testid="workbench-shortcut-save"]')
      await until(
        readRegistry,
        values => values.find(app => app.id === installationId)?.shortcut === null,
        'Clearing a shortcut did not remove its binding'
      )
      await control.command('clickWhenEnabled', '[data-testid="workbench-background"]')
      await until(
        readRegistry,
        values => values.find(app => app.id === installationId)?.background === false,
        'Closing-window policy was not persisted'
      )
      await closeSettings()
      await ready()
      await workbenchApp('fill', { selector: input, value: 'Keep after close' })
      await workbenchApp('fill', {
        selector: reminderTime,
        value: localDateTime(new Date(Date.now() + 3_600_000)),
      })
      await workbenchApp('click', { selector: '[data-testid="todo-add"]' })
      await until(
        data,
        value => value.reminders.length === 1,
        'The close-policy reminder was not saved'
      )
      await workbenchApp('close')
      await until(
        state,
        value => !value.running,
        'Closing a background-disabled view kept its runtime running'
      )
      assert.equal(
        (await data()).reminders.length,
        1,
        'Closing the last view removed a durable reminder'
      )
      await cli(['launch', '--id', installationId])
      await owned()
      await menu('smart-app-remove-local')
      await control.command('waitFor', '[data-testid="smart-app-remove-local-confirm"]')
      assert.equal((await state()).running, true, 'Remove stopped the app before confirmation')
      await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
      await until(
        readRegistry,
        values => !values.some(app => app.id === installationId),
        'Removal retained the installation'
      )
      await until(state, value => !value.running, 'Removal retained the runtime')
      await assert.rejects(readFile(dataPath), { code: 'ENOENT' })
      await assert.rejects(readFile(join(desktopDirectory, filename)), { code: 'ENOENT' })

      // Extended workbenches share the same DSH lifecycle and movable surface.
      const extendedPath = join(workspacePath, 'extended workbench')
      await cli([
        'create',
        '--project',
        extendedPath,
        '--name',
        'extended-counter',
        '--display-name',
        'Extended counter',
        '--flavor',
        'extended',
      ])
      const bundle = join(extendedPath, 'packages', 'bundle', 'extended-counter')
      const counter = `window.__ModuleLoader__.load({id:'@wework-smart-app/extended-counter',factory:require=>{const React=require('react');function Counter(){const [count,setCount]=React.useState(0);return React.createElement('main',{'data-testid':'smart-app-ready'},React.createElement('button',{'data-testid':'counter-add',onClick:()=>setCount(value=>value+1)},'Add'),React.createElement('output',{'data-testid':'counter-value'},String(count)))}return{inject:['slots'],apply(ctx){return ctx.slots.register({name:'root',priority:-1},Counter)}}}})`
      await writeFile(join(bundle, 'src', 'client.js'), counter)
      await execFileAsync(process.execPath, ['scripts/build.mjs'], { cwd: extendedPath })
      const pendingInstall = cli(['install', '--project', extendedPath])
      void pendingInstall.catch(() => {})
      await reviewInstallation('accept')
      const extended = await pendingInstall
      installationId = extended.id
      assert.equal(extended.flavor, 'extended')
      await until(
        state,
        value => value.running && value.visible && value.presentation === 'window',
        'Extended workbench did not open in an independent window',
        workbenchReadyTimeoutMs
      )
      await until(
        () => workbenchApp('getText', { selector: '[data-testid="counter-value"]' }),
        value => value === '0',
        'The extended DSH client did not initialize'
      )
      await workbenchApp('click', { selector: '[data-testid="counter-add"]' })
      await until(
        () => workbenchApp('getText', { selector: '[data-testid="counter-value"]' }),
        value => value === '1',
        'The extended counter did not update'
      )
      const extendedContents = (await state()).contentsId
      for (const presentation of ['tab', 'window']) {
        await cli(['launch', '--id', installationId, '--presentation', presentation])
        assert.equal(
          (await state()).contentsId,
          extendedContents,
          'The extended presentation switch recreated its renderer'
        )
        assert.equal(
          await workbenchApp('getText', { selector: '[data-testid="counter-value"]' }),
          '1',
          'The extended presentation switch lost memory state'
        )
      }
      await cli(['remove', '--id', installationId])
      await until(state, value => !value.running, 'Extended removal retained its runtime')
      await rm(extendedPath, { recursive: true })
      await taskFixture.verify(control, { reviewInstallation, until })
    },
  }
}
