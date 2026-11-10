import assert from 'node:assert/strict'
import { createDesktopScenario as createCloudProjectFixture } from './collaboration-template-app-device-routing.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectCollaborationProjectView } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = id => `${CONTENT} [data-testid="${id}"]`

// User story: importing into an existing cloud project also offers a model choice.
export function createDesktopScenario(options) {
  const fixture = createCloudProjectFixture(options)
  let cloud
  const agents = async projectId => {
    const response = await fetch(
      `${cloud.backendUrl}/api/v1/cloud-projects/${projectId}/chat-agents`,
      {
        headers: { Authorization: `Bearer ${cloud.authToken}` },
        signal: AbortSignal.timeout(options.uiTimeoutMs),
      }
    )
    assert.ok(response.ok, `Cloud Agent list failed: ${response.status}`)
    return response.json()
  }
  return {
    ...fixture,
    async prepareCloud(environment) {
      cloud = environment
      await fixture.prepareCloud(environment)
    },
    async verify(control) {
      // Reuse real project creation, device aliases and project authorization checks.
      await fixture.verify(control)
      const snapshot = JSON.parse(await control.command('snapshot'))
      const route = new URL(snapshot.location)
      const projectId = route.searchParams.get('projectId')
      assert.ok(projectId, 'The existing cloud project must remain selected')
      const before = await agents(projectId)
      await selectCollaborationProjectView(control, CONTENT, 'manage', options.uiTimeoutMs)
      // A project may only have one issue-created routing rule; disable the fixture's first rule.
      await control.command(
        'click',
        selector('collaboration-project-settings-automatic-processing')
      )
      const enabledRule = `${CONTENT} [data-testid^="automatic-processing-enabled-"][aria-checked="true"]`
      await control.command('waitFor', enabledRule)
      await control.command('clickWhenEnabled', enabledRule)
      await control.command('waitFor', enabledRule, { visible: false })
      await control.command('click', selector('collaboration-project-settings-sharing'))
      await control.command('clickWhenEnabled', selector('project-template-import'))
      await control.command('click', selector('template-tab-discover'))
      await control.command('clickWhenEnabled', selector('template-details-product-lifecycle'))
      await control.command('clickWhenEnabled', selector('template-use'))
      const field = selector('template-model-codex')
      await control.command('waitFor', `${field}:enabled`)
      await control.command('fill', selector('template-group-name-main'), {
        value: `云端模型选择-${process.pid}`,
      })
      await control.command('fill', field, { value: '' })
      await control.command('waitFor', `${selector('template-bindings-apply')}:disabled`)
      assert.deepEqual(
        (await agents(projectId)).map(agent => agent.id),
        before.map(agent => agent.id)
      )
      const catalog = await requestExecutor(
        control,
        'runtime.runner.catalog',
        {},
        options.uiTimeoutMs
      )
      const model = catalog.models.find(item => item.runtime === 'codex')
      assert.ok(model)
      await control.command('fill', field, {
        value: JSON.stringify([model.runtime, model.provider, model.model_id]),
      })
      await options.captureScreenshot(control, 'template-cloud-model-selection-ready.png', CONTENT)
      await control.command('clickWhenEnabled', selector('template-bindings-apply'))
      await control.command('waitFor', selector('template-bindings-apply'), { visible: false })
      const imported = (await agents(projectId)).filter(
        agent => !before.some(item => item.id === agent.id)
      )
      assert.equal(imported.length, 6, 'Cloud import must create all bundled Agents')
      for (const agent of imported) {
        const policy = agent.modelPolicy ?? agent.model_policy
        assert.equal(policy.mode, 'fixed')
        assert.equal(policy.model.provider, model.provider)
        assert.equal(policy.model.model_id, model.model_id)
        const execution = agent.executionPolicy ?? agent.execution_policy
        assert.deepEqual(execution, before[0].executionPolicy ?? before[0].execution_policy)
      }
    },
  }
}
