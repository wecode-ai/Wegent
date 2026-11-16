import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  configureFirstProjectExecutionEnvironment,
  createLocalCollaborationProject,
  selectCollaborationProjectView,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = id => `${CONTENT} [data-testid="${id}"]`

// User story: choose an available model while importing a team, without editing runtime defaults.
export function createDesktopScenario({ uiTimeoutMs, captureScreenshot }) {
  return {
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      const name = `模板模型选择-${process.pid}`
      await createLocalCollaborationProject(control, CONTENT, name)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      await selectCollaborationProjectView(control, CONTENT, 'manage', uiTimeoutMs)
      await control.command('click', selector('collaboration-project-settings-sharing'))
      await control.command('clickWhenEnabled', selector('project-template-import'))
      await control.command('click', selector('template-tab-discover'))
      await control.command('clickWhenEnabled', selector('template-details-product-lifecycle'))
      await control.command('clickWhenEnabled', selector('template-use'))
      await control.command(
        'clickWhenEnabled',
        `${selector('template-runtime-configuration')} > summary`,
        {
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      const modelSelector = selector('template-model-codex')
      await control.command('waitFor', `${modelSelector}:enabled`)
      const initialCatalog = await requestExecutor(
        control,
        'runtime.runner.catalog',
        {},
        uiTimeoutMs
      )
      const model = initialCatalog.models.find(item => item.runtime === 'codex')
      assert.ok(model, 'The real executor must expose a selectable native Codex model')
      // Clearing an optional choice keeps import available; execution validates missing choices later.
      await control.command('fill', modelSelector, { value: '' })
      await control.command('waitFor', `${selector('template-bindings-apply')}:enabled`)
      const project = (await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)).find(
        item => item.name === name
      )
      assert.ok(project)
      const before = await requestExecutor(
        control,
        'chat_agents.list',
        { project_id: project.id },
        uiTimeoutMs
      )
      const value = JSON.stringify([model.runtime, model.provider, model.model_id])
      await control.command('fill', modelSelector, { value })
      // Folding optional settings must not discard an explicit model choice.
      await control.command('click', `${selector('template-runtime-configuration')} > summary`)
      await control.command('click', `${selector('template-runtime-configuration')} > summary`)
      await control.command('waitFor', `${modelSelector}:enabled`)
      assert.equal(await control.command('getValue', modelSelector), value)
      const selectedEnvironmentId = await control.command(
        'getValue',
        selector('template-project-environment-select')
      )
      await captureScreenshot(control, 'template-model-selection-ready.png', CONTENT)
      await control.command('clickWhenEnabled', selector('template-bindings-apply'))
      await control.command('waitFor', selector('template-bindings-apply'), { visible: false })
      const after = await requestExecutor(
        control,
        'chat_agents.list',
        { project_id: project.id },
        uiTimeoutMs
      )
      const imported = after.filter(agent => !before.some(previous => previous.id === agent.id))
      assert.ok(imported.length > 0, 'Import must persist new Agents')
      for (const agent of imported) {
        assert.equal(agent.execution_policy.mode, 'fixed')
        assert.equal(agent.execution_policy.environment_id, selectedEnvironmentId)
        assert.equal(agent.model_policy.mode, 'fixed')
        assert.equal(agent.model_policy.model.provider, model.provider)
        assert.equal(agent.model_policy.model.model_id, model.model_id)
      }
      const finalCatalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
      assert.deepEqual(
        finalCatalog.models,
        initialCatalog.models,
        'Import must not change device defaults'
      )
    },
  }
}
