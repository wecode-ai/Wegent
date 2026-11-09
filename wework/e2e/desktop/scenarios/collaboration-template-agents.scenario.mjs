import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  configureFirstProjectExecutionEnvironment,
  createLocalCollaborationProject,
  selectCollaborationProjectView,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = name => `${CONTENT} [data-testid="${name}"]`
const PICKER = `${selector('collaboration-project-create-dialog')} [data-testid="collaboration-template-dialog"]`
const pickerSelector = name => `${PICKER} [data-testid="${name}"]`

export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
  resultDir,
}) {
  const executionMarker = `IMPORTED_TEMPLATE_EXECUTION_${process.pid}`
  let modelExecuted = false
  let executionActive = false
  let importedTemplateId
  let unavailableTemplateId
  let authorId
  return {
    requiresCloudEnvironment: true,
    async prepareApp({ appEnvironment }) {
      // This isolated fixture deliberately has no Claude model configured.
      appEnvironment.WEGENT_CLAUDE_HOME = join(resultDir, 'unconfigured-claude')
    },
    async handleHttp(request, response, url) {
      if (
        !executionActive ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      const content = JSON.stringify(body)
      if (content.includes(executionMarker)) {
        assert.ok(
          content.includes('你是项目负责人。'),
          'The imported coordinator prompt must reach the real executor'
        )
        modelExecuted = true
      }
      const id = `imported-template-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage('模板智能体自动处理成功'),
          responseCompleted(id),
        ])
      )
      return true
    },
    async prepareCloud(environment) {
      const request = async (path, method, body, token = environment.authToken) => {
        const response = await fetch(`${environment.backendUrl}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const data = await response.json()
        assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`)
        return data
      }
      await request('/api/admin/setup-complete', 'POST')
      const user_name = `template-author-${process.pid}`
      const password = `template-test-${process.pid}`
      await request('/api/admin/users', 'POST', {
        user_name,
        password,
        role: 'user',
        auth_source: 'password',
      })
      const author = await request('/api/auth/login', 'POST', { user_name, password })
      const document = JSON.parse(
        await readFile(
          new URL('../../../../shared/data/collaboration-templates.json', import.meta.url),
          'utf8'
        )
      )[0]
      document.metadata = { name: `portable-agents-${process.pid}`, namespace: 'default' }
      document.spec.displayName = `跨账号智能体模板-${process.pid}`
      const saved = await request(
        `/api/v1/collaboration-templates/${document.metadata.name}`,
        'PUT',
        { document, expectedRevision: null },
        author.access_token
      )
      importedTemplateId = saved.id
      authorId = saved.ownerId
      await request(
        '/api/resource-library/listings',
        'POST',
        {
          resource_type: 'template',
          source_id: saved.id,
          display_name: document.spec.displayName,
          version: document.spec.version,
          status: 'published',
        },
        author.access_token
      )
      await request(`/api/resource-library/listings/${saved.id}/install`, 'POST', {
        target_namespace: 'default',
      })
      const unavailable = structuredClone(document)
      unavailable.metadata.name = `unconfigured-agent-${process.pid}`
      unavailable.spec.displayName = `待配置模型模板-${process.pid}`
      unavailable.spec.resources.collaboration.agents[0].runtime = 'claude_code'
      unavailableTemplateId = (
        await request(`/api/v1/collaboration-templates/${unavailable.metadata.name}`, 'PUT', {
          document: unavailable,
          expectedRevision: null,
        })
      ).id
    },
    async verify(control) {
      const name = `模板内置智能体-${process.pid}`
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, name)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      await selectCollaborationProjectView(control, CONTENT, 'manage', uiTimeoutMs)
      await control.command('click', selector('collaboration-project-settings-sharing'))
      await control.command('clickWhenEnabled', selector('project-template-import'))
      await control.command('click', selector('template-tab-available'))
      await control.command('waitFor', selector(`template-details-${importedTemplateId}`))
      await control.command('click', selector(`template-details-${importedTemplateId}`))
      await control.command('waitFor', selector('template-preview-agents'), { text: '自动创建' })
      await captureScreenshot(control, 'template-agents-01-preview.png', CONTENT)
      await control.command('click', selector('template-use'))
      await control.command('waitFor', selector('template-agents-summary'), {
        text: '将创建 6 个智能体',
      })
      for (let i = 0; i < 6; i++) {
        assert.equal(
          await control.command('getValue', selector(`template-role-main-role-${i}`)),
          `agent:template-agent:main-role-${i}`
        )
      }
      await captureScreenshot(control, 'template-agents-02-ready-without-selection.png', CONTENT)
      const originalWindowSize = await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1024, height: 720 }),
      })
      await control.command('waitFor', selector('template-agents-summary'), {
        text: '将创建 6 个智能体',
      })
      await captureScreenshot(control, 'template-agents-02b-narrow-confirmation.png', CONTENT)
      await control.command('setMainWindowSize', 'body', {
        value: originalWindowSize,
      })
      await control.command('click', selector('template-customize-main'))
      await control.command('waitFor', selector('template-role-main-role-0'), { visible: true })
      await control.command('click', selector('template-customize-main'))
      await control.command('clickWhenEnabled', selector('template-bindings-apply'))
      await control.command('waitFor', selector('template-bindings-apply'), { visible: false })
      const project = (await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)).find(
        project => project.name === name
      )
      const agents = await requestExecutor(
        control,
        'chat_agents.list',
        { project_id: project.id },
        uiTimeoutMs
      )
      const group = project.metadata.collaboration_groups[0]
      const definitions = JSON.parse(
        await readFile(
          new URL('../../../../shared/data/collaboration-templates.json', import.meta.url),
          'utf8'
        )
      )[0].spec.resources.collaboration
      for (const definition of definitions.agents) {
        const created = agents.filter(
          agent => agent.name === definition.name || agent.display_name === definition.name
        )
        assert.equal(created.length, 1, `Must create one ${definition.name}`)
        assert.equal(created[0].system_prompt, definition.systemPrompt)
        assert.ok(
          group.members.some(member => member.kind === 'agent' && member.id === created[0].id)
        )
      }
      assert.equal(
        group.leader.id,
        agents.find(agent => agent.name === definitions.agents[0].name).id
      )
      for (const stage of group.stages)
        assert.ok(agents.some(agent => agent.id === stage.assignee.id))
      assert.ok(!JSON.stringify(group).includes('template-agent:'))
      assert.ok(
        agents.every(agent => agent.created_by_user_id !== authorId),
        'Imported Agents must be owned by the destination account'
      )
      const rule = project.metadata.automatic_processing_rules.find(
        rule => rule.event_type === 'task.created' || rule.eventType === 'task.created'
      )
      assert.ok(rule, 'Template task routing must persist')
      await control.command('click', selector('collaboration-project-settings-agents'))
      await control.command('waitFor', selector('project-agent-add'))
      await captureScreenshot(control, 'template-agents-03-created-agents.png', CONTENT)
      await control.command('click', selector('collaboration-project-settings-sharing'))
      await control.command('clickWhenEnabled', selector('project-template-save'))
      await control.command('waitFor', selector('template-save-name'))
      await captureScreenshot(
        control,
        'template-agents-04-save-portable-configuration.png',
        CONTENT
      )
      const savedName = `可移植智能体配置-${process.pid}`
      await control.command('fill', selector('template-save-name'), { value: savedName })
      await control.command('clickWhenEnabled', selector('template-save-confirm'))
      await control.command('waitFor', selector('collaboration-template-dialog'), {
        text: '已保存到我的模板',
      })
      await control.command('click', selector('template-save-close'))
      await control.command('click', selector('collaboration-primary-templates'))
      await control.command('click', selector('template-tab-mine'))
      const card = await waitForTestIdByText(control, CONTENT, 'template-card-', savedName)
      await control.command('click', selector(card.replace('template-card-', 'template-details-')))
      await control.command('waitFor', selector('collaboration-template-preview'), {
        text: '研发工程师',
      })
      await captureScreenshot(control, 'template-agents-05-saved-definition.png', CONTENT)
      await control.command('click', selector('template-use'))
      const copiedName = `模板新项目-${process.pid}`
      await control.command('fill', selector('collaboration-project-name-input'), {
        value: copiedName,
      })
      await control.command('click', selector('project-create-choose-template'))
      await control.command('click', pickerSelector('template-tab-mine'))
      await control.command('waitFor', pickerSelector(`template-details-${unavailableTemplateId}`))
      await control.command('click', pickerSelector(`template-details-${unavailableTemplateId}`))
      await control.command('waitFor', pickerSelector('template-use'))
      await control.command('click', pickerSelector('template-use'))
      await control.command('waitFor', PICKER, { visible: false })
      await control.command('waitFor', selector('project-create-template-section'), {
        text: `待配置模型模板-${process.pid}`,
      })
      const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
      assert.equal(
        catalog.models.some(model => model.runtime === 'claude_code' && model.is_default),
        false
      )
      const before = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      await control.command('clickWhenEnabled', selector('collaboration-project-create-confirm'))
      await control.command('waitFor', `${CONTENT} .collaboration-project-create-error`, {
        text: '请先为当前执行环境设置默认模型',
      })
      const [error] = JSON.parse(
        await control.command('getElementMetrics', `${CONTENT} .collaboration-project-create-error`)
      )
      const [footer] = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${CONTENT} .collaboration-project-create-footer`
        )
      )
      const [dialog] = JSON.parse(
        await control.command('getElementMetrics', selector('collaboration-project-create-dialog'))
      )
      const [confirm] = JSON.parse(
        await control.command('getElementMetrics', selector('collaboration-project-create-confirm'))
      )
      const layout = JSON.stringify({ error, footer, dialog, confirm }, null, 2)
      await writeFile(join(resultDir, 'template-agents-error-layout.json'), `${layout}\n`)
      await captureScreenshot(
        control,
        'template-agents-05b-model-required-before-creation.png',
        CONTENT
      )
      assert.ok(
        error.height > 0 && error.top >= footer.top && error.bottom <= footer.bottom,
        'The complete error message must stay in the non-scrolling footer'
      )
      assert.ok(
        error.scrollHeight <= error.clientHeight + 1 && error.scrollWidth <= error.clientWidth + 1,
        'The error message must not clip its text'
      )
      assert.ok(
        error.bottom <= confirm.top && confirm.bottom <= dialog.bottom,
        `The error and create action must be readable together without scrolling: ${layout}`
      )
      const after = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      assert.equal(
        after.length,
        before.length,
        'A failed preflight must not persist an empty project'
      )
      assert.equal(
        after.some(project => project.name === copiedName),
        false
      )
      await control.command('click', selector('project-create-choose-template'))
      await control.command('click', pickerSelector('template-tab-mine'))
      await control.command(
        'waitFor',
        pickerSelector(card.replace('template-card-', 'template-details-'))
      )
      await control.command(
        'click',
        pickerSelector(card.replace('template-card-', 'template-details-'))
      )
      await control.command('waitFor', pickerSelector('template-use'))
      await control.command('click', pickerSelector('template-use'))
      await control.command('waitFor', PICKER, { visible: false })
      await control.command('waitFor', selector('project-create-template-section'), {
        text: savedName,
      })
      assert.equal(
        await control.command('getValue', selector('collaboration-project-name-input')),
        copiedName
      )
      await control.command('waitFor', `${CONTENT} .collaboration-project-create-error`, {
        visible: false,
      })
      await control.command('clickWhenEnabled', selector('collaboration-project-create-confirm'))
      // Provisioning creates six agents, their group, routing rules, and the board.
      // Observe its success or error before starting the ordinary UI render budget.
      await control.command(
        'waitFor',
        `${selector('collaboration-platform-root')}:not(:has([data-testid="collaboration-project-create-dialog"])), ${CONTENT} .collaboration-project-create-error`,
        { timeoutMs: workbenchReadyTimeoutMs }
      )
      await control.command('waitFor', `${CONTENT} .collaboration-project-create-error`, {
        visible: false,
      })
      await control.command('waitFor', selector('cloud-project-header-title'), { text: copiedName })
      await control.command('waitFor', selector('board-view-picker'), { text: '项目阶段' })
      const projects = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      assert.equal(projects.filter(project => project.name === copiedName).length, 1)
      const copied = projects.find(project => project.name === copiedName)
      const copiedAgents = await requestExecutor(
        control,
        'chat_agents.list',
        { project_id: copied.id },
        uiTimeoutMs
      )
      for (const definition of definitions.agents) {
        const recreated = copiedAgents.filter(
          agent => agent.name === definition.name || agent.display_name === definition.name
        )
        assert.equal(recreated.length, 1)
        assert.equal(recreated[0].system_prompt, definition.systemPrompt)
        assert.notEqual(recreated[0].id, agents.find(agent => agent.name === definition.name).id)
      }
      await captureScreenshot(control, 'template-agents-06-reapplied-with-stage-board.png', CONTENT)
      executionActive = true
      await control.command('clickWhenEnabled', selector('collaboration-issue-create'))
      await control.command('fill', selector('cloud-todo-title'), { value: executionMarker })
      await control.command('fill', selector('cloud-todo-detail-description'), {
        value: `${executionMarker}。请确认已收到此需求并完成处理。`,
      })
      await control.command('clickWhenEnabled', selector('cloud-todo-create-confirm'))
      await waitForBoardValue(
        async () => {
          const items = await requestExecutor(
            control,
            'todos.list',
            { project_id: copied.id },
            uiTimeoutMs
          )
          return items.some(
            item =>
              item.title === executionMarker &&
              item.metadata?.collaboration_group?.id === copied.metadata.collaboration_groups[0].id
          )
        },
        true,
        'A new issue must be automatically assigned to the imported group',
        modelResponseTimeoutMs
      )
      await waitForBoardValue(
        async () => modelExecuted,
        true,
        'The imported coordinator must execute with the destination model configuration',
        modelResponseTimeoutMs
      )
      await control.command('waitFor', selector('cloud-task-activity-list'), {
        text: '已完成本轮评估',
        timeoutMs: modelResponseTimeoutMs,
      })
      await captureScreenshot(control, 'template-agents-06b-automatic-execution.png', CONTENT)
      await control.command('click', selector('cloud-todo-detail-close'))
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('waitFor', '[data-testid="appearance-mode-dark"]')
      await control.command('click', '[data-testid="appearance-mode-dark"]')
      await control.command('waitFor', 'html[data-theme="dark"]')
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/local/${copied.id}`,
      })
      await control.command('waitFor', selector('cloud-project-header-title'), { text: copiedName })
      await control.command('click', selector('collaboration-primary-templates'))
      await control.command('click', selector('template-tab-mine'))
      await control.command('click', selector(card.replace('template-card-', 'template-details-')))
      await control.command('click', selector('template-use'))
      await control.command('waitFor', selector('template-agents-summary'), {
        text: '将创建 6 个智能体',
      })
      await captureScreenshot(control, 'template-agents-07-dark-confirmation.png', CONTENT)
      // Reselecting the same template starts a fresh role configuration.
      await control.command('click', selector('template-remove-role-group-1-role-1'))
      await control.command('waitFor', selector('template-agents-summary'), {
        text: '将创建 5 个智能体',
      })
      await control.command('click', selector('project-create-choose-template'))
      await control.command('click', pickerSelector('template-tab-mine'))
      const savedDetails = pickerSelector(card.replace('template-card-', 'template-details-'))
      await control.command('waitFor', savedDetails)
      await control.command('click', savedDetails)
      await control.command('click', pickerSelector('template-use'))
      await control.command('waitFor', PICKER, { visible: false })
      await control.command('waitFor', selector('template-agents-summary'), {
        text: '将创建 6 个智能体',
      })
      // Import a coordinator-only variant and verify removed roles and their stages stay absent.
      for (let index = 1; index < 6; index++) {
        await control.command('click', selector(`template-remove-role-group-1-role-${index}`))
      }
      await control.command('waitFor', selector('template-agents-summary'), {
        text: '将创建 1 个智能体',
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            selector('template-remove-role-group-1-role-0') + ':disabled'
          )
        ),
        1,
        'The coordinator must remain required'
      )
      const reducedName = `模板精简角色-${process.pid}`
      await control.command('fill', selector('collaboration-project-name-input'), {
        value: reducedName,
      })
      await control.command('clickWhenEnabled', selector('collaboration-project-create-confirm'))
      await control.command('waitFor', selector('cloud-project-header-title'), {
        text: reducedName,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const reduced = (await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)).find(
        project => project.name === reducedName
      )
      assert.ok(reduced, 'The reduced template must create a project')
      const reducedAgents = await requestExecutor(
        control,
        'chat_agents.list',
        {
          project_id: reduced.id,
        },
        uiTimeoutMs
      )
      assert.equal(reducedAgents.length, 1, 'Removed roles must not create Agents')
      const reducedGroup = reduced.metadata.collaboration_groups[0]
      assert.equal(reducedGroup.members.length, 1)
      assert.equal(reducedGroup.leader.id, reducedAgents[0].id)
      assert.deepEqual(
        reducedGroup.stages.map(stage => stage.name),
        definitions.groups[0].stages.filter(stage => !stage.ownerRole).map(stage => stage.name)
      )
    },
  }
}
