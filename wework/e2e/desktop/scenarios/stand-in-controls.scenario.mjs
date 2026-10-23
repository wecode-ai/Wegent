import { openProjectStandIn, discardStandInDraft } from '../modules/stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = `分身独立控制-${process.pid}`
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
      const open = () => openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`)
      const cancel = () => discardStandInDraft(control)

      await open()
      assert.equal(await control.command('getAttribute', AUTO, { value: 'role' }), 'switch')
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
    },
  }
}
