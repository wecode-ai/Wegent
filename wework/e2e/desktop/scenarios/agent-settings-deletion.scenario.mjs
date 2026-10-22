import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import {
  inCollaborationSidebar,
  selectCollaborationDomain,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const id = value => `[data-testid="${value}"]`
const EDITOR = id('wework-agent-resource-creator')
const NAME = id('wework-agent-display-name')
const DELETE = id('wework-agent-resource-creator-delete')
const CONFIRM = id('collaboration-delete-agent-confirm')

// The real API owns every resource and mutation. Only transport failures are injected.
export function createDesktopScenario({ uiTimeoutMs }) {
  const appEnvironment = {}
  let cloud
  let proxy
  let workspace
  const request = async path => {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      headers: { Authorization: `Bearer ${cloud.authToken}` },
    })
    assert.equal(response.ok, true, `${path}: HTTP ${response.status}`)
    return response.json()
  }
  const resources = () => request('/v1/resources')
  const agents = async () =>
    (await resources()).agents.map(item => ({
      ...item,
      id: String(item.resource_id ?? item.team_id ?? item.id),
    }))
  const sidebar = name => inCollaborationSidebar(id(`collaboration-primary-${name}`), CONTENT)
  async function reopen(control) {
    await control.command('click', sidebar('home'))
    await control.command('click', sidebar('agents'))
    await control.command('waitFor', scoped(id('collaboration-agents-page')))
  }
  async function create(control, name) {
    await control.command('click', scoped(id('collaboration-agents-create')))
    await control.command('waitFor', EDITOR)
    await control.command('fill', NAME, { value: name })
    await control.command('clickWhenEnabled', id('wework-agent-resource-create'))
    await control.command('waitFor', EDITOR, { visible: false })
    const row = await waitForTestIdByText(
      control,
      scoped(id('collaboration-agents-page')),
      'collaboration-agents-row-',
      name,
      uiTimeoutMs
    )
    return { row, resourceId: row.slice('collaboration-agents-row-'.length), name }
  }
  async function edit(control, agent) {
    await control.command('click', scoped(id(`collaboration-agents-settings-${agent.resourceId}`)))
    await control.command('waitFor', DELETE)
  }
  async function absent(control, agent) {
    await control.command('waitFor', EDITOR, { visible: false })
    await reopen(control)
    assert.equal(Number(await control.command('getElementCount', scoped(id(agent.row)))), 0)
    assert.equal(
      (await agents()).some(item => item.id === agent.resourceId),
      false,
      'Deleted cloud Agent remained in the authoritative catalog'
    )
  }

  return {
    requiresCloudEnvironment: true,
    appEnvironment,
    async prepareCloud(environment) {
      cloud = environment
      proxy = await new TransportFaultProxy(cloud.backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
      const response = await fetch(`${cloud.backendUrl}/api/admin/setup-complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cloud.authToken}` },
      })
      assert.equal(response.ok, true)
      const created = await fetch(`${cloud.backendUrl}/api/v1/workspaces`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Deletion review ${process.pid}` }),
      })
      assert.equal(created.ok, true)
      workspace = await created.json()
    },
    setCloudEnvironment(value) {
      cloud = value
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', id('workspace-tab-select-fixed-board'))
      await control.command('click', id('workspace-tab-select-fixed-board'))
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      const workspaceTree = inCollaborationSidebar(
        id(`collaboration-workspace-tree-${workspace.id}`),
        CONTENT
      )
      await control.command('waitFor', workspaceTree)
      await control.command('click', `${workspaceTree} .collaboration-workspace-identity`)
      await control.command('click', sidebar('agents'))
      await control.command('waitFor', scoped(id('collaboration-agents-page')))
      const retained = await create(control, `Retained Agent ${process.pid}`)
      const deleted = await create(control, `Deleted Agent ${process.pid}`)
      const persisted = (await agents()).find(item => item.id === deleted.resourceId)
      assert.ok(persisted?.team_id, 'The cloud Agent was not persisted')
      const team = await request(`/teams/${persisted.team_id}`)
      assert.notEqual(
        team.name,
        persisted.name,
        'The fixture must distinguish technical and display names'
      )
      const deletePath = `/api/teams/${persisted.team_id}`
      try {
        await edit(control, deleted)
        const draft = `${deleted.name} unsaved`
        await control.command('fill', NAME, { value: draft })
        proxy.rule = entry =>
          entry.method === 'DELETE' && entry.path === deletePath ? 'reset-request' : null
        await control.command('click', DELETE)
        await control.command('click', CONFIRM)
        await control.command(
          'waitFor',
          `${id('collaboration-delete-agent-dialog')} [role="alert"]`
        )
        assert.ok(
          (await agents()).some(item => item.id === deleted.resourceId),
          'Failed deletion removed the cloud Agent'
        )
        await control.command('click', id('collaboration-delete-agent-cancel'))
        await control.command('waitFor', EDITOR)
        assert.equal(
          await control.command('getValue', NAME),
          draft,
          'Failed deletion discarded the settings draft'
        )

        proxy.rule = () => null
        await control.command('click', DELETE)
        await control.command('click', CONFIRM)
        await absent(control, deleted)
        await control.command('waitFor', scoped(id(retained.row)))

        const refresh = await create(control, `Refresh failure Agent ${process.pid}`)
        await edit(control, refresh)
        proxy.rule = entry =>
          entry.method === 'GET' && entry.path === '/api/v1/resources' ? 'reset-request' : null
        await control.command('click', DELETE)
        await control.command('click', CONFIRM)
        await control.command('waitFor', EDITOR, { visible: false })
        await control.command('waitFor', scoped('[role="alert"]'), { text: '部分资源加载失败' })
        assert.equal(
          (await agents()).some(item => item.id === refresh.resourceId),
          false
        )
        assert.ok(
          (await agents()).some(item => item.id === retained.resourceId),
          'The refresh failure deleted an unrelated Agent'
        )
        proxy.rule = () => null
        await absent(control, refresh)
        await control.command('waitFor', scoped(id(retained.row)))
      } finally {
        proxy.rule = () => null
      }
    },
    diagnostics: () => ({ requests: proxy?.requests }),
    async cleanup() {
      await proxy?.stop()
    },
  }
}
