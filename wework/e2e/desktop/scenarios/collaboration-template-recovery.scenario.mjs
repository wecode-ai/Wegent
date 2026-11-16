import assert from 'node:assert/strict'
import { createDesktopScenario as createTemplateScenario } from './collaboration-templates.scenario.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = id => `${CONTENT} [data-testid="${id}"]`
const alert = `${selector('collaboration-template-dialog')} [role="alert"]`

/** Share the existing CI checkpoint's Backend and Electron rather than starting another pair. */
export async function createDesktopScenario(options) {
  const existing = await createTemplateScenario(options)
  let cloud, workspace, project
  const people = []
  const initialName = `全员绑定失败恢复-${process.pid}`
  const finalName = `${initialName}-完成`
  const projectPath = () => `/api/v1/cloud-projects/${project.id}`
  const groupsPath = () => `${projectPath()}/collaboration-groups`

  async function request(path, method = 'GET', body) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function assertDraft(control, expectedName) {
    assert.equal(
      await control.command('getValue', selector('template-group-name-main')),
      expectedName
    )
    for (const [index, person] of people.entries()) {
      assert.equal(
        await control.command('getValue', selector(`template-role-main-role-${index}`)),
        `human:${person.id}`,
        'A failed import must preserve every existing-member binding'
      )
    }
  }

  async function expectFailure(control, text, status) {
    await control.command('clickWhenEnabled', selector('template-bindings-apply'))
    await control.command('waitFor', alert, { text })
    await control.command('waitFor', `${selector('template-bindings-apply')}:enabled`)
    const message = await control.command('getText', alert)
    assert.ok(message.includes(`HTTP ${status}`), 'The visible cause must retain its HTTP status')
    assert.ok(
      !message.includes('检查连接'),
      'A real HTTP validation or conflict response must not be described as a connection failure'
    )
    await assertDraft(control, initialName)
  }

  return {
    ...existing,
    async prepareCloud(environment) {
      await existing.prepareCloud(environment)
      cloud = environment
      people.push(await request('/api/users/me'))
      workspace = await request('/api/v1/workspaces', 'POST', {
        name: `Template recovery ${process.pid}`,
      })
      project = await request('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: `六个既有成员模板验收-${process.pid}`,
        task_provider: 'local',
        visibility: 'private',
      })
      for (let index = 1; index < 6; index++) {
        const person = await request('/api/admin/users', 'POST', {
          user_name: `template-recovery-${process.pid}-${index}`,
          password: 'template-recovery-e2e-only',
          role: 'user',
          auth_source: 'password',
        })
        people.push(person)
        await request(`${projectPath()}/members`, 'POST', {
          user_id: person.id,
          role: 'Developer',
        })
      }
    },
    async verify(control) {
      await existing.verify(control)
      await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
      await control.command('waitFor', selector('cloud-project-header-title'), {
        text: project.name,
      })
      await selectCollaborationProjectView(control, CONTENT, 'manage')
      await control.command('click', selector('collaboration-project-settings-sharing'))
      await control.command('clickWhenEnabled', selector('project-template-import'))
      await control.command('click', selector('template-tab-discover'))
      await control.command('clickWhenEnabled', selector('template-details-product-lifecycle'))
      await control.command('clickWhenEnabled', selector('template-use'))
      await control.command('click', selector('template-customize-main'))
      for (const [index, person] of people.entries()) {
        const role = selector(`template-role-main-role-${index}`)
        await control.command('waitFor', `${role} option[value="human:${person.id}"]`)
        await control.command('select', role, { value: `human:${person.id}` })
      }
      await control.command('fill', selector('template-group-name-main'), { value: initialName })
      await control.command('waitFor', selector('template-agents-summary'), { text: '0 个智能体' })
      assert.equal((await request(`${projectPath()}/chat-agents`)).length, 0)

      // Revoke after loading the dialog so the real API, rather than a stale picker, rejects it.
      const memberPath = `${projectPath()}/members/${people[5].id}`
      await request(memberPath, 'PATCH', { role: 'Viewer' })
      await expectFailure(control, '成员', 422)
      assert.deepEqual((await request(groupsPath())).items, [])
      await options.captureScreenshot(control, 'template-recovery-member-permission.png', CONTENT)
      await request(memberPath, 'PATCH', { role: 'Developer' })

      // Another client creates the chosen name after the dialog's initial name check.
      const members = people.map(person => ({ kind: 'human', id: String(person.id) }))
      const duplicate = await request(groupsPath(), 'POST', {
        name: initialName,
        leader: members[0],
        members,
        stages: [],
      })
      await expectFailure(control, '名称', 409)
      assert.deepEqual(
        (await request(groupsPath())).items.map(group => group.id),
        [duplicate.id],
        'A name conflict must not create another group'
      )
      await options.captureScreenshot(control, 'template-recovery-duplicate-name.png', CONTENT)
      await request(`${groupsPath()}/${duplicate.id}`, 'DELETE')

      // The original six bindings remain usable after fixing permissions and the collision.
      await control.command('fill', selector('template-group-name-main'), { value: finalName })
      await assertDraft(control, finalName)
      await control.command('clickWhenEnabled', selector('template-bindings-apply'))
      await control.command('waitFor', selector('template-bindings-apply'), { visible: false })
      const groups = (await request(groupsPath())).items
      assert.equal(groups.length, 1)
      assert.equal(groups[0].name, finalName)
      assert.deepEqual(
        groups[0].members.map(member => `${member.kind}:${member.id}`).sort(),
        people.map(person => `human:${person.id}`).sort()
      )
      assert.equal(groups[0].stages.length, 6)
      assert.equal((await request(`${projectPath()}/chat-agents`)).length, 0)
      const rules = await request(`${projectPath()}/automations`)
      assert.equal(rules.length, 1)
      assert.equal(rules[0].enabled, true)
      assert.equal(rules[0].target_kind, 'collaboration_group')
      assert.equal(rules[0].target_id, groups[0].id)
      const latest = await request(projectPath())
      const board = latest.board_views.views.find(
        view => view.id === latest.board_views.default_view_id
      )
      assert.equal(board.columns.filter(column => column.type === 'tag').length, 6)
      await control.command('click', selector('collaboration-project-settings-groups'))
      await control.command('waitFor', selector('collaboration-project-groups-page'), {
        text: finalName,
      })
      await options.captureScreenshot(
        control,
        'template-recovery-six-existing-members.png',
        CONTENT
      )
    },
    async cleanup() {
      try {
        if (project) {
          const latest = await request(projectPath())
          await request(`${projectPath()}?version=${latest.version}`, 'DELETE')
        }
        if (workspace) {
          const path = `/api/v1/workspaces/${workspace.id}`
          const latest = await request(path)
          await request(`${path}?version=${latest.version}`, 'DELETE')
        }
      } finally {
        await existing.cleanup?.()
      }
    },
  }
}
