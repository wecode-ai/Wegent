import { openProjectStandIn, discardStandInDraft } from '../modules/stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
  reloadMainWindow,
} from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = `分身交互-${process.pid}`
const MARKER = `STAND_IN_ASSIGNED_${process.pid}`
const AGENT_PROMPT = `STAND_IN_AGENT_INSTRUCTIONS_${process.pid}`
// The ordinary desktop fixture authenticates /api/users/me as this account.
const USER_ID = 9001

async function waitForExecution(control, issueId, timeoutMs, roleIds = ['default']) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    const bindings = await requestExecutor(control, 'todos.bindings', { task_id: issueId }, 10000)
    assert.ok(
      bindings.length <= roleIds.length,
      'A stand-in created duplicate tasks for one assignment'
    )
    latest = []
    for (const binding of bindings) {
      const { task } = await requestExecutor(
        control,
        'runtime.tasks.get',
        { taskId: binding.task_id },
        10000
      )
      assert.notEqual(task?.status, 'failed', JSON.stringify(task))
      latest.push(task)
    }
    if (latest.length === roleIds.length && latest.every(task => task?.status === 'done')) {
      const owners = []
      for (const task of latest) {
        const transcript = await requestExecutor(
          control,
          'runtime.tasks.transcript',
          { taskId: task.taskId, limit: 5 },
          10000
        )
        owners.push(transcript.origin.standInId)
      }
      assert.deepEqual(
        owners.sort(),
        [...roleIds].sort(),
        'Every matching stand-in must own one execution'
      )
      return latest
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`Stand-in tasks did not complete: ${JSON.stringify(latest)}`)
}

export async function createDesktopScenario({
  executorHome,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  captureScreenshot,
}) {
  const claudeHome = join(executorHome, 'claude')
  await mkdir(claudeHome, { recursive: true })
  await writeFile(
    join(claudeHome, 'settings.json'),
    JSON.stringify({
      model: 'claude-catalog-e2e',
      env: {
        ANTHROPIC_BASE_URL: 'https://claude-gateway.example.invalid',
        ANTHROPIC_AUTH_TOKEN: 'synthetic-claude-token',
      },
    }),
    { flag: 'wx' }
  )
  let requests = 0
  let agentRequests = 0
  const tagRequests = { review: 0, docs: 0 }
  return {
    appEnvironment: { WEGENT_CLAUDE_HOME: claudeHome },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const text = JSON.stringify(body)
      const id = `stand-in-${Date.now()}`
      const kind = codexRequestKind(body)
      assert.ok(
        !text.includes('Select exactly one role for this task.'),
        'Connected stand-ins must not invoke a role selection model'
      )
      if (text.includes(MARKER) && kind !== 'prewarm' && kind !== 'compaction') requests += 1
      if (text.includes(AGENT_PROMPT) && kind !== 'prewarm' && kind !== 'compaction')
        agentRequests += 1
      for (const tag of Object.keys(tagRequests)) {
        if (text.includes(`${MARKER}_${tag}`) && kind !== 'prewarm' && kind !== 'compaction')
          tagRequests[tag] += 1
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(text.includes(MARKER) ? '已核对任务和验证结果。' : 'Ready'),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      const claudeCatalog = await requestExecutor(
        control,
        'runtime.runner.catalog',
        {},
        uiTimeoutMs
      )
      assert.ok(!claudeCatalog.errors.includes('claude_provider_required'))
      assert.ok(!claudeCatalog.errors.includes('claude_catalog_invalid'))
      assert.ok(claudeCatalog.runtimes.includes('claude_code'))
      const claude = claudeCatalog.models.find(model => model.model_id === 'claude-catalog-e2e')
      assert.ok(claude, 'Custom Claude models must load without a manually configured provider')
      assert.equal(claude.runtime, 'claude_code')
      assert.notEqual(claude.provider, 'anthropic')
      assert.equal(claude.account_label, 'Claude')
      assert.equal(claude.is_default, true)
      assert.ok(!JSON.stringify(claudeCatalog).includes('synthetic-claude-token'))
      assert.ok(!JSON.stringify(claudeCatalog).includes('claude-gateway.example.invalid'))
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      await control.command('click', `${CONTENT} [data-testid="collaboration-tab-board"]`)
      const projects = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      const project = projects.find(row => row.name === PROJECT)
      assert.ok(project)
      const old = await requestExecutor(
        control,
        'todos.create',
        { project_id: project.id, todo: { title: '启用前的任务', assignee_user_id: USER_ID } },
        uiTimeoutMs
      )
      await captureScreenshot(control, 'stand-in-01-project-entry.png')
      assert.equal(
        await control.command(
          'getElementCount',
          '[data-testid="stand-in-open"] svg[data-state="disabled"]'
        ),
        '1'
      )
      await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-project-select"]')
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-project-select"]'),
        'default'
      )
      await captureScreenshot(
        control,
        'stand-in-project-01-picker.png',
        '[data-testid="stand-in-settings"]'
      )
      await control.command('select', '[data-testid="stand-in-project-select"]', { value: '__new' })
      await control.command('waitFor', '[data-testid="stand-in-role-name"]')
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-role-name"]'),
        `${PROJECT} 分身`
      )
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      assert.equal(await control.command('getElementCount', '[data-testid="stand-in-device"]'), '0')
      await captureScreenshot(
        control,
        'stand-in-project-02-new-draft.png',
        '[data-testid="stand-in-settings"]'
      )
      await control.command('click', '[data-testid="stand-in-cancel"]')
      await control.command('waitFor', '[data-testid="stand-in-project-select"]')
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-role-name"]'),
        '0'
      )
      const cancelled = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER_ID },
        uiTimeoutMs
      )
      assert.equal(cancelled.roles.length, 1, 'Cancel must not create a personal stand-in')
      assert.equal(
        cancelled.roles[0].collaboration.enabled,
        false,
        'Cancel must not connect the project'
      )
      await control.command('select', '[data-testid="stand-in-project-select"]', {
        value: cancelled.roles[0].id,
      })
      await control.command('waitFor', '[data-testid="stand-in-project-summary"]')
      await captureScreenshot(
        control,
        'stand-in-project-03-existing-summary.png',
        '[data-testid="stand-in-settings"]'
      )
      await control.command('click', '[data-testid="stand-in-close"]')
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`, {
        requirements: false,
      })
      await control.command('waitFor', '[data-testid="stand-in-auto"][aria-checked="false"]')
      await captureScreenshot(
        control,
        'stand-in-02-single-role-main.png',
        '[data-testid="stand-in-settings"]'
      )
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      await captureScreenshot(
        control,
        'stand-in-03-requirements.png',
        '[data-testid="stand-in-settings"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-auto"]')
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      assert.equal(await control.command('getValue', '[data-testid="stand-in-agent"]'), '')
      await control.command('fill', '[data-testid="stand-in-prompt"]', { value: '不保存的提示词' })
      await discardStandInDraft(control)
      const initial = await requestExecutor(
        control,
        'runtime.stand_in.get',
        { projectId: project.id, userId: USER_ID, projectStore: 'local' },
        uiTimeoutMs
      )
      assert.equal(initial.enabled, false)
      assert.equal(initial.prompt, '')
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`, {
        connect: true,
        onConnections: () =>
          captureScreenshot(
            control,
            'stand-in-04-connections.png',
            '[data-testid="stand-in-settings"]'
          ),
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-auto"]')
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      await control.command('fill', '[data-testid="stand-in-prompt"]', { value: MARKER })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      const saved = await requestExecutor(
        control,
        'runtime.stand_in.get',
        { projectId: project.id, userId: USER_ID, projectStore: 'local' },
        uiTimeoutMs
      )
      assert.equal(saved.enabled, true)
      assert.ok(saved.executionDeviceId)
      assert.equal(saved.prompt, MARKER)
      await control.command('waitFor', `${CONTENT} [data-testid="stand-in-project-${project.id}"]`)
      // The project header reloads after saving; the sidebar can already be visible.
      await control.command('waitFor', `${CONTENT} [data-testid="stand-in-enabled"]`)
      await captureScreenshot(control, 'stand-in-05-saved-project-status.png')
      assert.equal(
        await control.command(
          'getElementCount',
          '[data-testid="stand-in-open"] svg[data-state="enabled"] > use, [data-testid="stand-in-open"] svg[data-state="enabled"] .stand-in-icon-shadow > use'
        ),
        '2'
      )
      await reloadMainWindow(control, 'Stand-in settings did not survive renderer reload')
      await control.command('waitFor', `${CONTENT} [data-testid="stand-in-project-${project.id}"]`)
      // Execution must not depend on the board being mounted or on composer navigation.
      await control.command('waitFor', `${CONTENT} [data-testid="collaboration-tab-table"]`, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `${CONTENT} [data-testid="collaboration-tab-table"]`)
      const issue = await requestExecutor(
        control,
        'todos.create',
        { project_id: project.id, todo: { title: '新分配给我的任务', assignee_user_id: USER_ID } },
        uiTimeoutMs
      )
      const other = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: { title: '分配给别人的任务', assignee_user_id: 2 },
        },
        uiTimeoutMs
      )
      const unassigned = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: { title: '未分配的任务' },
        },
        uiTimeoutMs
      )
      await waitForExecution(control, issue.id, modelResponseTimeoutMs)
      const oldBindings = await requestExecutor(
        control,
        'todos.bindings',
        { task_id: old.id },
        uiTimeoutMs
      )
      assert.equal(oldBindings.length, 0)
      const current = await requestExecutor(
        control,
        'todos.get',
        { project_id: project.id, task_id: issue.id },
        uiTimeoutMs
      )
      assert.equal(current.assignee_user_id, USER_ID)
      assert.equal(
        current.status,
        'in_review',
        'Completion must use the ordinary Runtime-to-Issue status projection'
      )
      assert.equal(requests, 1)
      const catalog = await requestExecutor(control, 'runtime.runner.catalog', {}, uiTimeoutMs)
      const model = catalog.models.find(row => row.runtime === 'codex' && row.is_default)
      assert.ok(model, 'The native default model is required for Stand-in agent selection')
      const agent = await requestExecutor(
        control,
        'chat_agents.create',
        {
          project_id: project.id,
          agent: {
            name: '分身专用助手',
            runtime: 'codex',
            system_prompt: AGENT_PROMPT,
            execution_policy: { mode: 'fixed', environment_id: saved.executionDeviceId },
            model_policy: {
              mode: 'fixed',
              model: { runtime: model.runtime, provider: model.provider, model_id: model.model_id },
            },
          },
        },
        uiTimeoutMs
      )
      await control.command('click', `${CONTENT} [data-testid="collaboration-tab-board"]`)
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-auto"][aria-checked="true"]')
      const concurrentSettings = await requestExecutor(
        control,
        'runtime.stand_in.get',
        {
          projectId: project.id,
          userId: USER_ID,
          projectStore: 'local',
        },
        uiTimeoutMs
      )
      await requestExecutor(
        control,
        'runtime.stand_in.save',
        {
          projectId: project.id,
          userId: USER_ID,
          projectStore: 'local',
          settings: concurrentSettings,
        },
        uiTimeoutMs
      )
      await control.command('fill', '[data-testid="stand-in-prompt"]', {
        value: `${MARKER} 保留草稿`,
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"] [role="alert"]')
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-prompt"]'),
        `${MARKER} 保留草稿`
      )
      await discardStandInDraft(control)
      // Personal settings close independently of the project board. Re-enter
      // the fixture project before using its project-scoped stand-in control.
      await control.command(
        'click',
        `${CONTENT} [data-testid="collaboration-workspace-project-${project.id}"]`
      )
      await control.command('waitFor', `${CONTENT} [data-testid="stand-in-open"]`)
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-auto"][aria-checked="true"]')
      assert.equal(await control.command('getValue', '[data-testid="stand-in-agent"]'), '')
      await control.command('waitFor', '[data-testid="stand-in-agent"] option', {
        text: '分身专用助手',
      })
      await control.command('select', '[data-testid="stand-in-agent"]', {
        value: JSON.stringify(['local', project.id, agent.id]),
      })
      await control.command('waitFor', '[data-testid="stand-in-project-agent-scope"]', {
        text: PROJECT,
      })
      await captureScreenshot(
        control,
        'stand-in-09-project-agent-scope.png',
        '[data-testid="stand-in-settings"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      const scoped = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER_ID },
        uiTimeoutMs
      )
      assert.deepEqual(scoped.roles[0].agentProject, { id: project.id, store: 'local' })
      assert.equal(scoped.roles[0].collaboration.allProjects, false)
      assert.deepEqual(scoped.roles[0].collaboration.projects, [{ id: project.id, store: 'local' }])
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`)
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-agent"]'),
        JSON.stringify(['local', project.id, agent.id])
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      const agentIssue = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: { title: '使用选定智能体处理', assignee_user_id: USER_ID },
        },
        uiTimeoutMs
      )
      await waitForExecution(control, agentIssue.id, modelResponseTimeoutMs)
      assert.equal(agentRequests, 1, 'The configured agent prompt did not reach the native model')
      // Editing an Issue must not create another task in later polling cycles.
      await requestExecutor(
        control,
        'todos.update',
        {
          project_id: project.id,
          task_id: issue.id,
          todo: { version: current.version, description: '更新描述仍属于同一次分配' },
        },
        uiTimeoutMs
      )
      await new Promise(resolve => setTimeout(resolve, 11000))
      assert.equal(requests, 2, 'Polling or editing duplicated a completed assignment')
      for (const excluded of [old, other, unassigned]) {
        assert.equal(
          (await requestExecutor(control, 'todos.bindings', { task_id: excluded.id }, uiTimeoutMs))
            .length,
          0
        )
      }
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-auto"][aria-checked="true"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-auto"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command(
        'waitFor',
        `${CONTENT} [data-testid="stand-in-project-${project.id}"]`,
        { visible: false }
      )
      await control.command(
        'waitFor',
        `${CONTENT} [data-testid="stand-in-open"] svg[data-state="disabled"]`
      )
      assert.equal(
        await control.command(
          'getElementCount',
          '[data-testid="stand-in-open"] svg[data-state="disabled"]'
        ),
        '1'
      )
      const disabledIssue = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: { title: '停用后分配的任务', assignee_user_id: USER_ID },
        },
        uiTimeoutMs
      )
      await new Promise(resolve => setTimeout(resolve, 11000))
      assert.equal(
        (
          await requestExecutor(
            control,
            'todos.bindings',
            { task_id: disabledIssue.id },
            uiTimeoutMs
          )
        ).length,
        0
      )
      assert.equal(requests, 2)
      const profiles = []
      for (const id of ['review', 'docs']) {
        profiles.push(
          await requestExecutor(
            control,
            'runtime.stand_in.save',
            {
              projectId: project.id,
              userId: USER_ID,
              projectStore: 'local',
              settings: {
                id,
                name: `${id} 分身`,
                tags: [id],
                agentId: agent.id,
                enabled: true,
                prompt: `${MARKER}_${id}`,
                executionDeviceId: saved.executionDeviceId,
                version: 0,
              },
            },
            uiTimeoutMs
          )
        )
      }
      const taggedIssues = []
      for (const tag of ['review', 'docs']) {
        taggedIssues.push(
          await requestExecutor(
            control,
            'todos.create',
            {
              project_id: project.id,
              todo: { title: `${tag} 标签路由`, tags: [tag], assignee_user_id: USER_ID },
            },
            uiTimeoutMs
          )
        )
      }
      const ambiguous = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: { title: '同时匹配两个分身', tags: ['review', 'docs'], assignee_user_id: USER_ID },
        },
        uiTimeoutMs
      )
      for (const [index, tagged] of taggedIssues.entries())
        await waitForExecution(control, tagged.id, modelResponseTimeoutMs, [
          index === 0 ? 'review' : 'docs',
        ])
      await waitForExecution(control, ambiguous.id, modelResponseTimeoutMs, ['review', 'docs'])
      await new Promise(resolve => setTimeout(resolve, 11000))
      assert.equal(requests, 6, 'Each eligible stand-in must execute each assignment exactly once')
      assert.equal(agentRequests, 5)
      assert.deepEqual(
        tagRequests,
        { review: 2, docs: 2 },
        'Each matching role must use its own prompt'
      )
      assert.equal(
        (await requestExecutor(control, 'todos.bindings', { task_id: ambiguous.id }, uiTimeoutMs))
          .length,
        2
      )
      assert.equal(
        (
          await requestExecutor(
            control,
            'todos.bindings',
            { task_id: disabledIssue.id },
            uiTimeoutMs
          )
        ).length,
        0
      )
      await reloadMainWindow(control, 'Named Stand-in indicators did not survive reload')
      await control.command('waitFor', `${CONTENT} [data-testid="stand-in-project-${project.id}"]`)
      for (const profile of profiles) {
        const read = await requestExecutor(
          control,
          'runtime.stand_in.get',
          {
            projectId: project.id,
            userId: USER_ID,
            projectStore: 'local',
            standInId: profile.id,
          },
          uiTimeoutMs
        )
        assert.deepEqual(read.tags, profile.tags)
        await requestExecutor(
          control,
          'runtime.stand_in.save',
          {
            projectId: project.id,
            userId: USER_ID,
            projectStore: 'local',
            settings: { ...read, enabled: false },
          },
          uiTimeoutMs
        )
      }
      // Create a personally owned stand-in through the project picker.
      await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-project-select"]')
      await control.command('select', '[data-testid="stand-in-project-select"]', { value: '__new' })
      await control.command('fill', '[data-testid="stand-in-role-name"]', { value: '项目协调' })
      await captureScreenshot(
        control,
        'stand-in-06-add-role.png',
        '[data-testid="stand-in-settings"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`, {
        requirements: false,
      })
      await control.command('waitFor', '[data-testid="stand-in-role-name"]')
      await captureScreenshot(
        control,
        'stand-in-07-multiple-roles.png',
        '[data-testid="stand-in-settings"]'
      )
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-scheduling-open"]'),
        '0'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      let personal = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER_ID },
        uiTimeoutMs
      )
      assert.ok(!Object.hasOwn(personal, 'autoSelect'))
      assert.ok(personal.roles.some(role => role.name === '项目协调'))
      personal = await requestExecutor(
        control,
        'runtime.stand_in.personal.save',
        {
          userId: USER_ID,
          settings: {
            ...personal,
            roles: personal.roles.map(role => ({
              ...role,
              enabled: ['review', 'docs'].includes(role.id),
            })),
          },
        },
        uiTimeoutMs
      )
      const overlappingIssue = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: {
            title: '所有连接的分身分别处理',
            tags: ['review', 'docs'],
            assignee_user_id: USER_ID,
          },
        },
        uiTimeoutMs
      )
      await waitForExecution(control, overlappingIssue.id, modelResponseTimeoutMs, [
        'review',
        'docs',
      ])
      const beforeReorder = { requests, ...tagRequests }
      personal = await requestExecutor(
        control,
        'runtime.stand_in.personal.save',
        {
          userId: USER_ID,
          settings: { ...personal, roles: [...personal.roles].reverse() },
        },
        uiTimeoutMs
      )
      await new Promise(resolve => setTimeout(resolve, 5500))
      assert.deepEqual(
        { requests, ...tagRequests },
        beforeReorder,
        'Saving roles must not replay completed work'
      )
      const singleIssue = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: { title: '仅文档分身接手', tags: ['docs'], assignee_user_id: USER_ID },
        },
        uiTimeoutMs
      )
      await waitForExecution(control, singleIssue.id, modelResponseTimeoutMs, ['docs'])
      personal = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER_ID },
        uiTimeoutMs
      )
      assert.ok(!Object.hasOwn(personal, 'selectionErrors'))
      await requestExecutor(
        control,
        'runtime.stand_in.personal.save',
        {
          userId: USER_ID,
          settings: {
            ...personal,
            roles: personal.roles.map(role => ({ ...role, enabled: false })),
          },
        },
        uiTimeoutMs
      )
      await control.command('click', `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-project-select"]')
      await control.command('select', '[data-testid="stand-in-project-select"]', { value: '__new' })
      await control.command('fill', '[data-testid="stand-in-role-name"]', { value: '项目专用分身' })
      await control.command('fill', '[data-testid="stand-in-prompt"]', {
        value: '仅为此项目处理分配给我的任务',
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      const created = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER_ID },
        uiTimeoutMs
      )
      const newRole = created.roles.find(row => row.name === '项目专用分身')
      assert.ok(newRole, 'A project-created stand-in must belong to the personal document')
      assert.equal(created.userId, USER_ID)
      assert.equal(newRole.enabled, false)
      assert.equal(newRole.collaboration.allProjects, false)
      assert.deepEqual(newRole.collaboration.projects, [{ id: project.id, store: 'local' }])
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('waitFor', '[data-testid="stand-in-overview"]')
      await control.command('waitFor', '[data-testid="stand-in-overview-status"]')
      await control.command('waitFor', '[data-testid="stand-in-overview-role-default"]')
      await control.command('click', '[data-testid="stand-in-overview-role-default"]')
      await control.command('waitFor', '[data-testid="stand-in-activity"]', { text: PROJECT })
      await captureScreenshot(control, 'stand-in-project-05-overview.png')
      await control.command('waitFor', `[data-testid="stand-in-overview-role-${newRole.id}"]`)
      await control.command('click', `[data-testid="stand-in-overview-role-${newRole.id}"]`)
      await control.command('click', '[data-testid="stand-in-settings-open"]')
      await control.command('waitFor', '[data-testid="stand-in-role-name"]')
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-role-select"]'),
        '0'
      )
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-role-name"]'),
        newRole.name
      )
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-prompt"]'),
        newRole.prompt
      )
      await captureScreenshot(control, 'stand-in-project-04-personal-ownership.png')
      const renamed = '项目代码审查'
      await control.command('fill', '[data-testid="stand-in-role-name"]', { value: renamed })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      await control.command('waitFor', `[data-testid="stand-in-overview-role-${newRole.id}"]`, {
        text: renamed,
      })
      const updated = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER_ID },
        uiTimeoutMs
      )
      assert.deepEqual(
        updated.roles,
        created.roles.map(role => ({
          ...role,
          name: role.id === newRole.id ? renamed : role.name,
          version: role.version + 1,
        }))
      )
      assert.equal(
        await control.command('getText', '[data-testid="stand-in-settings-open"]'),
        '设置'
      )
      await control.command('click', '[data-testid="stand-in-settings-open"]')
      await control.command('waitFor', '[data-testid="stand-in-role-name"]')
      assert.equal(await control.command('getValue', '[data-testid="stand-in-role-name"]'), renamed)
      await control.command('fill', '[data-testid="stand-in-role-name"]', { value: '未保存的名字' })
      await control.command('click', '[data-testid="stand-in-profile-backdrop"]')
      await control.command('waitFor', '[data-testid="stand-in-discard"]')
      await control.command('click', '[data-testid="stand-in-keep-editing"]')
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-role-name"]'),
        '未保存的名字'
      )
      await control.command('click', '[data-testid="stand-in-profile-backdrop"]')
      await control.command('click', '[data-testid="stand-in-discard"]')
      await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
      await control.command('click', '[data-testid="stand-in-memory-open"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-memory-add"]')
      const scopes = await control.command('getText', '[data-testid="stand-in-memory-scope"]')
      assert.ok(scopes.includes(`${renamed}（与你聊天时）`), scopes)
      assert.ok(scopes.includes(`项目 · ${PROJECT}`), scopes)
      assert.ok(!scopes.includes('standIn.'), scopes)
      assert.ok(!scopes.includes(`项目 · ${project.id}`), scopes)
      await control.command('click', '[data-testid="stand-in-memory-cancel"]')
      await control.command('click', '[data-testid="stand-in-memory-close"]')
    },
    diagnostics() {
      return { project: PROJECT, requests, agentRequests, tagRequests }
    },
  }
}
