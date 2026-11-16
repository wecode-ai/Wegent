import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  expandCollaborationSpaces,
  openDirectProjectCreation,
} from '../modules/workspace-flows.mjs'
import { verifyProjectAgentEditing } from '../modules/project-agent-editing.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const PROJECT_NAME = `模板设备身份-${process.pid}`
const WORKSPACE_NAME = `模板设备身份空间-${process.pid}`
const TEMPLATE_DISPLAY_NAME = `模板设备身份模板-${process.pid}`

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let environment
  let workspace
  let templateId
  let definitions

  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await response.json()
    assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`)
    return data
  }

  return {
    requiresCloudEnvironment: true,
    setCloudEnvironment(value) {
      environment = value
    },
    async prepareCloud(value) {
      cloud = value
      await request('/api/admin/setup-complete', { method: 'POST' })
      workspace = await request('/api/v1/workspaces', {
        method: 'POST',
        body: {
          name: WORKSPACE_NAME,
          description:
            'Verifies cloud projects resolve template Agents through APP device aliases.',
        },
      })
      const document = JSON.parse(
        await readFile(
          new URL('../../../../shared/data/collaboration-templates.json', import.meta.url),
          'utf8'
        )
      )[0]
      document.metadata = { name: `template-app-device-${process.pid}`, namespace: 'default' }
      document.spec.displayName = TEMPLATE_DISPLAY_NAME
      definitions = document.spec.resources.collaboration
      templateId = (
        await request(`/api/v1/collaboration-templates/${document.metadata.name}`, {
          method: 'PUT',
          body: { document, expectedRevision: null },
        })
      ).id
    },
    async verify(control) {
      const appDevice = await environment.waitForConnectedAppDevice()
      assert.ok(appDevice.id, 'The current APP device must have a persisted record id')
      assert.ok(appDevice.app_device_id, 'The current APP device must expose its app device id')
      assert.notEqual(
        appDevice.device_id,
        appDevice.app_device_id,
        'This regression requires distinct logical and APP device identities'
      )

      const workspaceEnvironments = await request(
        `/api/v1/workspaces/${workspace.id}/execution-environments`
      )
      if (!workspaceEnvironments.items.some(item => item.device_id === appDevice.id)) {
        await request(`/api/v1/workspaces/${workspace.id}/execution-environments`, {
          method: 'POST',
          body: { device_id: appDevice.id },
        })
      }
      const currentEnvironment = (
        await request(`/api/v1/workspaces/${workspace.id}/execution-environments`)
      ).items.find(item => item.device_id === appDevice.id)
      assert.ok(
        currentEnvironment,
        'The current APP device must be a workspace execution environment'
      )
      assert.equal(currentEnvironment.app_device_id, appDevice.app_device_id)
      assert.notEqual(
        currentEnvironment.device_key,
        currentEnvironment.app_device_id,
        'The execution environment must expose the APP alias independently of its route key'
      )

      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await expandCollaborationSpaces(control, CONTENT)
      const workspaceTree = scoped(`[data-testid="collaboration-workspace-tree-${workspace.id}"]`)
      await control.command('waitFor', workspaceTree, { timeoutMs: workbenchReadyTimeoutMs })
      await control.command('click', `${workspaceTree} .collaboration-workspace-identity`)
      await openDirectProjectCreation(control, CONTENT)

      const dialog = scoped('[data-testid="collaboration-project-create-dialog"]')
      await control.command('waitFor', dialog, { timeoutMs: uiTimeoutMs })
      await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
        value: PROJECT_NAME,
      })
      await control.command('click', scoped('[data-testid="project-create-choose-template"]'))
      const picker = `${dialog} [data-testid="collaboration-template-dialog"]`
      await control.command('waitFor', picker, { timeoutMs: uiTimeoutMs })
      await control.command('click', `${picker} [data-testid="template-tab-mine"]`)
      await control.command('waitFor', `${picker} [data-testid="template-details-${templateId}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `${picker} [data-testid="template-details-${templateId}"]`)
      await control.command('waitFor', `${picker} [data-testid="template-use"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `${picker} [data-testid="template-use"]`)
      await control.command('waitFor', picker, { visible: false, timeoutMs: uiTimeoutMs })
      await control.command('waitFor', scoped('[data-testid="project-create-template-section"]'), {
        text: TEMPLATE_DISPLAY_NAME,
        timeoutMs: uiTimeoutMs,
      })

      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="collaboration-project-create-confirm"]'),
        { timeoutMs: uiTimeoutMs }
      )
      const header = scoped('[data-testid="cloud-project-header-title"]')
      const error = scoped('.collaboration-project-create-error')
      await control.command('waitFor', `${header}, ${error}`, {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      assert.equal(
        Number(await control.command('getElementCount', error, { visible: true })),
        0,
        `Template creation failed: ${await control.command('getText', error)}`
      )
      await control.command('waitFor', header, {
        text: PROJECT_NAME,
        timeoutMs: workbenchReadyTimeoutMs,
      })

      const projects = await request(`/api/v1/workspaces/${workspace.id}/projects`)
      const project = projects.items.find(item => item.name === PROJECT_NAME)
      assert.ok(project, 'The cloud project was not persisted')
      const agents = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`)
      assert.equal(
        agents.length,
        definitions.agents.length,
        'Template creation must materialize every bundled Agent'
      )
      for (const definition of definitions.agents) {
        const created = agents.filter(
          agent =>
            agent.name === definition.name ||
            agent.displayName === definition.name ||
            agent.display_name === definition.name
        )
        assert.equal(created.length, 1, `Missing bundled Agent ${definition.name}`)
        assert.equal(created[0].systemPrompt ?? created[0].system_prompt, definition.systemPrompt)
        assert.deepEqual(created[0].executionPolicy ?? created[0].execution_policy, {
          mode: 'fixed',
          environment_id: String(appDevice.id),
        })
        assert.equal((created[0].modelPolicy ?? created[0].model_policy)?.mode, 'fixed')
      }

      const groups = (await request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`))
        .items
      const group = groups.find(candidate => candidate.name === definitions.groups[0].name)
      assert.ok(group, 'The template collaboration group was not created')
      assert.ok(
        group.members.some(member => member.kind === 'agent' && member.id === agents[0].id),
        'The collaboration group was not bound to the materialized Agents'
      )
      assert.ok(!JSON.stringify(group).includes('template-agent:'))

      const projectEnvironments = await request(
        `/api/v1/cloud-projects/${project.id}/execution-environments`
      )
      assert.ok(
        projectEnvironments.items.some(item => item.device_id === appDevice.id),
        'The APP device must be authorized on the created project'
      )
      await captureScreenshot(control, 'template-app-device-routing-created.png', CONTENT)
      await verifyProjectAgentEditing(control, CONTENT, project, agents[0], request)
    },
  }
}
