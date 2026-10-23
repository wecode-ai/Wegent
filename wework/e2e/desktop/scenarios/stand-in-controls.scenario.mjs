import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
  reloadMainWindow,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = `替身独立控制-${process.pid}`
const USER_ID = 9001
const AUTO = '[data-testid="stand-in-auto"]'
const PROMPT = '[data-testid="stand-in-prompt"]'
const SAVE = '[data-testid="stand-in-save"]'

/** Save automatic handling and execution settings together against the real Executor. */
export function createDesktopScenario({ uiTimeoutMs }) {
  return {
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', `${CONTENT} [data-testid="collaboration-primary-stand-in"]`)
      await control.command('waitFor', '[data-testid="stand-in-page"]')
      await control.command('waitFor', '[data-testid="stand-in-list-empty"]')
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-list-error"]'),
        '0',
        'Opening My Stand-in must not surface a Runtime RPC error'
      )
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      await control.command('click', `${CONTENT} [data-testid="collaboration-tab-board"]`)
      const projects = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      const project = projects.find(row => row.name === PROJECT)
      assert.ok(project)
      const read = () =>
        requestExecutor(
          control,
          'runtime.stand_in.get',
          {
            projectId: project.id,
            userId: USER_ID,
            projectStore: 'local',
          },
          uiTimeoutMs
        )
      const open = async () => {
        await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
        await control.command('waitFor', PROMPT, { timeoutMs: uiTimeoutMs })
      }
      const cancel = () => control.command('click', '[data-testid="stand-in-cancel"]')

      await open()
      assert.equal(await control.command('getAttribute', AUTO, { value: 'type' }), 'checkbox')
      await control.command('waitFor', `${AUTO}[aria-checked="false"]`)
      await control.command('clickWhenEnabled', AUTO)
      await control.command('waitFor', AUTO + '[aria-checked="true"]')
      assert.equal((await read()).enabled, false, 'First activation requires saving settings')
      await cancel()
      assert.equal((await read()).version, 0, 'Cancel must not create a configuration')

      await open()
      await control.command('fill', PROMPT, { value: 'Saved manual settings' })
      await control.command('clickWhenEnabled', SAVE)
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      let saved = await read()
      assert.equal(saved.enabled, false)
      assert.equal(saved.prompt, 'Saved manual settings')

      await open()
      await control.command('clickWhenEnabled', AUTO)
      await control.command('waitFor', `${AUTO}[aria-checked="true"]`)
      assert.equal((await read()).enabled, false, 'Existing configurations also wait for Save')
      assert.equal((await read()).version, saved.version, 'Editing a checkbox must not persist')
      await control.command('fill', PROMPT, { value: 'Unsaved changes' })
      await control.command('clickWhenEnabled', AUTO)
      await control.command('waitFor', `${AUTO}[aria-checked="false"]`)
      saved = await read()
      assert.equal(saved.enabled, false)
      assert.equal(saved.prompt, 'Saved manual settings', 'Turning off must not save the draft')
      assert.equal(await control.command('getValue', PROMPT), 'Unsaved changes')
      await cancel()

      await open()
      assert.equal(await control.command('getValue', PROMPT), 'Saved manual settings')
      await control.command('fill', PROMPT, { value: 'Confirmed new settings' })
      await control.command('clickWhenEnabled', AUTO)
      await control.command('waitFor', AUTO + '[aria-checked="true"]')
      assert.equal((await read()).enabled, false, 'Pending edits require explicit save and enable')
      await control.command('clickWhenEnabled', SAVE)
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      saved = await read()
      assert.equal(saved.enabled, true)
      assert.equal(saved.prompt, 'Confirmed new settings')

      await open()
      await control.command('clickWhenEnabled', AUTO)
      await control.command('waitFor', `${AUTO}[aria-checked="false"]`)
      await cancel()
      assert.equal(
        (await read()).enabled,
        true,
        'Cancel must discard the unsaved disable selection'
      )
      await open()
      await control.command('waitFor', AUTO + '[aria-checked="true"]')
      assert.equal(await control.command('getValue', PROMPT), 'Confirmed new settings')
      await control.command('clickWhenEnabled', AUTO)
      await control.command('fill', PROMPT, { value: 'Saved disabled settings' })
      assert.equal((await read()).enabled, true, 'Disabling must wait for Save')
      await control.command('clickWhenEnabled', SAVE)
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      saved = await read()
      assert.equal(saved.enabled, false)
      assert.equal(saved.prompt, 'Saved disabled settings')

      // The top-level page must read the saved configuration from the local Runtime.
      await control.command('click', `${CONTENT} [data-testid="collaboration-primary-stand-in"]`)
      await control.command('waitFor', '[data-testid="stand-in-page"]')
      await control.command('waitFor', `[data-testid="stand-in-list-row-${project.id}"]`, {
        text: '未开启',
      })
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-list-error"]'),
        '0',
        'The saved Stand-in must be readable from the top-level page'
      )
      await control.command('click', `[data-testid="stand-in-list-edit-${project.id}"]`)
      await control.command('waitFor', PROMPT)
      assert.equal(await control.command('getValue', PROMPT), 'Saved disabled settings')
      await control.command('waitFor', `${AUTO}[aria-checked="false"]`)
      await control.command('click', '[data-testid="stand-in-page-editor-close"]')
      await control.command('waitFor', '[data-testid="stand-in-page-editor"]', { visible: false })

      // Cancel must discard a draft opened from the page.
      await control.command('click', '[data-testid="stand-in-list-configure"]')
      await control.command('waitFor', '[data-testid="stand-in-page-editor"]', { visible: true })
      await control.command('waitFor', PROMPT)
      assert.equal(await control.command('getValue', PROMPT), 'Saved disabled settings')
      await control.command('fill', PROMPT, { value: 'Discarded from page' })
      await control.command('clickWhenEnabled', AUTO)
      await control.command('waitFor', `${AUTO}[aria-checked="true"]`)
      await cancel()
      await control.command('waitFor', '[data-testid="stand-in-page-editor"]', { visible: false })
      saved = await read()
      assert.equal(saved.enabled, false)
      assert.equal(saved.prompt, 'Saved disabled settings')

      // Saving from the page refreshes the list without reopening the page.
      await control.command('click', '[data-testid="stand-in-list-configure"]')
      await control.command('waitFor', PROMPT)
      await control.command('fill', PROMPT, { value: 'Configured from page' })
      await control.command('clickWhenEnabled', AUTO)
      await control.command('waitFor', `${AUTO}[aria-checked="true"]`)
      await control.command('clickWhenEnabled', SAVE)
      await control.command('waitFor', '[data-testid="stand-in-page-editor"]', { visible: false })
      await control.command('waitFor', `[data-testid="stand-in-list-row-${project.id}"]`, {
        text: '已开启',
      })
      saved = await read()
      assert.equal(saved.enabled, true)
      assert.equal(saved.prompt, 'Configured from page')

      // Reopening My Stand-in after a renderer reload must still list the saved Stand-in.
      await reloadMainWindow(control, 'Stand-in settings did not survive renderer reload')
      await control.command('waitFor', '[data-testid="workspace-tab-strip"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', CONTENT, { visible: true, timeoutMs: uiTimeoutMs })
      await control.command('click', `${CONTENT} [data-testid="collaboration-primary-stand-in"]`)
      await control.command('waitFor', `[data-testid="stand-in-list-row-${project.id}"]`, {
        text: '已开启',
      })
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-list-error"]'),
        '0',
        'Reopening My Stand-in after reload must not surface an error'
      )
      await control.command('click', `[data-testid="stand-in-list-edit-${project.id}"]`)
      await control.command('waitFor', PROMPT)
      assert.equal(await control.command('getValue', PROMPT), 'Configured from page')
      await control.command('waitFor', AUTO + '[aria-checked="true"]')
      await control.command('click', '[data-testid="stand-in-page-editor-close"]')
    },
  }
}
