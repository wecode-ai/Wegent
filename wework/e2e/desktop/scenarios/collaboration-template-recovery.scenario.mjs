import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDesktopScenario as createTemplateScenario } from './collaboration-templates.scenario.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = id => `${CONTENT} [data-testid="${id}"]`
const alert = `${selector('collaboration-template-dialog')} [role="alert"]`

async function loadTemplateHelpers() {
  const source = new URL('../../../../packages/collaboration/src/', import.meta.url)
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const packageImport = context.parentURL?.startsWith(source.href)
      // Prebuilt Core shards reuse the bundled parser and do not install workspace packages.
      if (packageImport && specifier === 'yaml' && process.env.WEWORK_E2E_YAML_PARSER) {
        return nextResolve(pathToFileURL(process.env.WEWORK_E2E_YAML_PARSER).href, context)
      }
      if (packageImport && specifier === '@wegent/chat-core/model-execution') {
        return nextResolve(new URL('../../chat-core/src/model-execution.ts', source).href, context)
      }
      const relativeImport = specifier.startsWith('./') || specifier.startsWith('../')
      return nextResolve(
        packageImport && relativeImport && !specifier.endsWith('.ts')
          ? `${specifier}.ts`
          : specifier,
        context
      )
    },
  })
  try {
    const [document, agents, intent] = await Promise.all([
      import(new URL('templates/document.ts', source)),
      import(new URL('templates/agents.ts', source)),
      import(new URL('templates/projectTemplateImportIntent.ts', source)),
    ])
    return { ...document, ...agents, ...intent }
  } finally {
    hook.deregister()
  }
}

/** Lose the first delivery, then forward its exact bytes after an independent replay commits. */
async function retainDisconnectedPost(body, headers) {
  let retained
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    retained = {
      body: Buffer.concat(chunks).toString('utf8'),
      headers: Object.fromEntries(
        ['authorization', 'content-type', 'x-template-import-id', 'x-template-import-step'].map(
          name => [name, request.headers[name]]
        )
      ),
    }
    response.destroy()
  })
  server.keepAliveTimeout = 0
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const request = httpRequest(
          `http://127.0.0.1:${server.address().port}/retained-agent`,
          { method: 'POST', headers },
          response => {
            response.resume()
            resolve(response.statusCode)
          }
        )
        request.once('error', reject)
        request.setTimeout(10_000, () =>
          request.destroy(new Error('Retained POST did not disconnect'))
        )
        request.end(JSON.stringify(body))
      }),
      error => error.code === 'ECONNRESET'
    )
    assert.ok(retained, 'The loopback proxy must retain the original request before disconnecting')
    return retained
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

/** Share the existing CI checkpoint's Backend and Electron rather than starting another pair. */
export async function createDesktopScenario(options) {
  const existing = await createTemplateScenario(options)
  const helpers = await loadTemplateHelpers()
  let cloud, workspace, project
  const people = []
  const initialName = `全员绑定失败恢复-${process.pid}`
  const finalName = `${initialName}-完成`
  const projectPath = () => `/api/v1/cloud-projects/${project.id}`
  const groupsPath = () => `${projectPath()}/collaboration-groups`
  const importsPath = () => `${projectPath()}/template-imports`

  async function request(path, method = 'GET', body, headers = {}) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
        ...headers,
      },
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
      const failedImports = (await request(importsPath())).items
      assert.equal(failedImports.length, 1)
      assert.ok(
        !Object.hasOwn(failedImports[0], 'intent'),
        'The import catalog must expose progress without decrypting saved configuration'
      )
      const frozenBase = await request(`${importsPath()}/${failedImports[0].id}`)
      assert.equal(frozenBase.status, 'pending')
      assert.deepEqual(
        frozenBase.steps.map(({ key, kind }) => ({ key, kind })),
        [
          { key: 'group:main', kind: 'group' },
          { key: 'automation:task-assignment', kind: 'automation' },
          { key: 'board:project-board', kind: 'board' },
        ]
      )
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
      assert.equal(rules[0].targetKind, 'collaboration_group')
      assert.equal(rules[0].targetId, groups[0].id)
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

      // Independent HTTP clients share a durable intent and serialize the real write transaction.
      const importPath = `${projectPath()}/template-imports`
      const step = { key: 'group:cross-client', kind: 'group' }
      const payload = { name: `${finalName}-跨客户端`, leader: members[0], members, stages: [] }
      const intent = { protocolVersion: 1, intent: { group: payload }, steps: [step] }
      const [first, second] = await Promise.all([
        request(importPath, 'POST', intent),
        request(importPath, 'POST', intent),
      ])
      assert.equal(
        first.id,
        second.id,
        'The server must join identical imports from different clients'
      )
      const headers = {
        'X-Template-Import-Id': first.id,
        'X-Template-Import-Step': step.key,
      }
      const [written, replayed] = await Promise.all([
        request(groupsPath(), 'POST', payload, headers),
        request(groupsPath(), 'POST', payload, headers),
      ])
      assert.equal(
        written.id,
        replayed.id,
        'Concurrent clients must receive the same committed resource'
      )
      // A new request recovers only the committed receipt, without relying on the first response.
      const recovered = await request(`${importPath}/${first.id}`)
      assert.equal(recovered.status, 'completed')
      assert.equal(recovered.steps[0].resourceId, written.id)
      assert.equal(
        (await request(groupsPath())).items.filter(group => group.name === payload.name).length,
        1
      )

      // Reproduce MAN03's wire order without depending on a platform's automatic POST retry.
      // A real loopback socket loses the first Agent request. The replay commits first, then
      // the retained original reaches the real Backend; Electron resumes the remaining steps.
      const agentDocument = structuredClone(frozenBase.intent.document)
      const agentConfiguration = agentDocument.spec.resources.collaboration
      const agentGroupName = `${finalName}-六角色断连恢复`
      assert.equal(agentConfiguration.agents.length, 6)
      assert.equal(agentConfiguration.groups.length, 1)
      agentConfiguration.groups[0].name = agentGroupName
      agentConfiguration.project.taskAssignment.enabled = false
      const agentDrafts = helpers.bindTemplate(
        agentDocument,
        helpers.templateAgentBindings(agentDocument)
      )
      const agentIntent = await helpers.freezeProjectTemplateImportIntent(
        agentDocument,
        agentDrafts,
        'zh-CN'
      )
      const agentOperation = await request(
        importsPath(),
        'POST',
        helpers.projectTemplateImportRequest(agentIntent)
      )
      assert.equal(agentOperation.steps.length, 9)
      const firstAgent = agentConfiguration.agents[0]
      assert.equal(
        agentConfiguration.groups[0].roles.find(
          role => role.key === agentConfiguration.groups[0].leaderRole
        ).agentKey,
        firstAgent.key,
        'The retained first step must be the project coordinator from the template'
      )
      const firstAgentStep = agentOperation.steps[0]
      assert.equal(firstAgentStep.key, `agent:${firstAgent.key}`)
      const agentPayload = helpers.templateAgentCreateInput(
        firstAgent,
        agentIntent.routings[firstAgent.runtime]
      )
      const agentHeaders = {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
        'X-Template-Import-Id': agentOperation.id,
        'X-Template-Import-Step': firstAgentStep.key,
      }
      const retained = await retainDisconnectedPost(agentPayload, agentHeaders)
      const agentPath = `${projectPath()}/chat-agents`
      const replayedAgent = await request(agentPath, 'POST', agentPayload, agentHeaders)
      const originalResponse = await fetch(`${cloud.backendUrl}${agentPath}`, {
        method: 'POST',
        headers: retained.headers,
        body: retained.body,
        signal: AbortSignal.timeout(10_000),
      })
      const originalBody = await originalResponse.text()
      assert.equal(originalResponse.status, 201, originalBody)
      const originalAgent = JSON.parse(originalBody)
      assert.equal(
        originalAgent.id,
        replayedAgent.id,
        'The late original and the replay must return the same committed Agent'
      )
      assert.equal((await request(agentPath)).length, 1)
      const savedAgentImport = (await request(importsPath())).items.find(
        operation => operation.id === agentOperation.id
      )
      assert.ok(savedAgentImport)
      assert.equal(savedAgentImport.steps.filter(step => step.resourceId).length, 1)
      assert.equal(savedAgentImport.steps[0].resourceId, replayedAgent.id)
      assert.ok(!Object.hasOwn(savedAgentImport, 'intent'))
      const savedAgentDetail = await request(`${importsPath()}/${agentOperation.id}`)
      assert.deepEqual(savedAgentDetail.intent.drafts, agentIntent.drafts)
      assert.equal(
        new Set(agentIntent.drafts[0].members.map(member => `${member.kind}:${member.id}`)).size,
        6
      )

      // Re-enter through the groups page rather than retaining the original bindings dialog.
      await control.command('click', selector('collaboration-project-settings-sharing'))
      await control.command('click', selector('collaboration-project-settings-groups'))
      await control.command('clickWhenEnabled', selector('template-import-recovery-open'))
      const pendingSelect = selector('template-import-recovery-select')
      await control.command('waitFor', `${pendingSelect} option[value="${agentOperation.id}"]`)
      await control.command('select', pendingSelect, { value: agentOperation.id })
      await control.command('waitFor', `${pendingSelect} option:checked`, { text: '1/9' })
      await control.command('waitFor', selector('template-import-recovery-preview'), {
        text: agentGroupName,
      })
      await control.command('waitFor', selector('template-import-recovery-preview'), {
        text: '6 名成员',
      })
      const beforeResume = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const logCursor = beforeResume.logs.at(-1).id
      await control.command('clickWhenEnabled', selector('template-import-recovery-resume'))
      await control.command('waitFor', selector('template-import-recovery-preview'), {
        visible: false,
      })
      await control.command('waitFor', selector('collaboration-project-groups-page'), {
        text: agentGroupName,
      })
      const completedAgentImport = await request(`${importsPath()}/${agentOperation.id}`)
      assert.equal(completedAgentImport.status, 'completed')
      assert.ok(completedAgentImport.steps.every(step => step.resourceId))
      assert.equal(completedAgentImport.steps[0].resourceId, replayedAgent.id)
      const agents = await request(agentPath)
      assert.equal(agents.length, 6, 'One six-role import must create exactly six Agents')
      assert.deepEqual(
        agents.map(agent => agent.name).sort(),
        agentConfiguration.agents.map(agent => agent.name).sort()
      )
      assert.equal(
        agents.filter(agent => agent.name === firstAgent.name).length,
        1,
        'The project coordinator must not be duplicated after the disconnected delivery'
      )
      const importedGroups = (await request(groupsPath())).items.filter(
        group => group.name === agentGroupName
      )
      assert.equal(importedGroups.length, 1)
      assert.equal(
        importedGroups[0].id,
        completedAgentImport.steps.find(step => step.kind === 'group').resourceId
      )
      assert.equal(importedGroups[0].members.length, 6)
      assert.ok(importedGroups[0].members.every(member => member.kind === 'agent'))
      assert.deepEqual(
        importedGroups[0].members.map(member => member.id).sort(),
        agents.map(agent => String(agent.team_id ?? agent.teamId ?? agent.id)).sort()
      )
      assert.equal(importedGroups[0].stages.length, 6)
      const afterResume = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      assert.ok(
        afterResume.logs.some(entry => entry.id === logCursor),
        'The request observation window must remain available for the replay assertion'
      )
      const resumedRequests = afterResume.logs.filter(entry => entry.id > logCursor)
      const agentPosts = resumedRequests.filter(
        entry =>
          entry.args[0] ===
          `[Wework] HTTP POST /v1/cloud-projects/${project.id}/chat-agents started.`
      )
      assert.equal(agentPosts.length, 5, 'Continue must create only the five uncommitted Agents')
      const resumedRules = await request(`${projectPath()}/automations`)
      const restoredRule = resumedRules.find(rule => rule.targetId === importedGroups[0].id)
      assert.ok(restoredRule)
      assert.equal(restoredRule.enabled, false)
      assert.equal(
        restoredRule.id,
        completedAgentImport.steps.find(step => step.kind === 'automation').resourceId
      )
      const resumedProject = await request(projectPath())
      const resumedBoardId = `template-import-${agentOperation.id}-view`
      assert.equal(resumedProject.board_views.default_view_id, resumedBoardId)
      assert.equal(
        resumedProject.board_views.views.filter(view => view.id === resumedBoardId).length,
        1
      )
      assert.equal(
        resumedProject.board_views.views
          .find(view => view.id === resumedBoardId)
          .columns.filter(column => column.type === 'tag').length,
        6
      )
      await options.captureScreenshot(control, 'template-recovery-six-agents-once.png', CONTENT)
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
