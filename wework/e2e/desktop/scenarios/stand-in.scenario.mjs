import { openProjectStandIn, discardStandInDraft } from '../modules/stand-in-flows.mjs'
import assert from 'node:assert/strict'
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
const PROJECT = `替身交互-${process.pid}`
const MARKER = `STAND_IN_ASSIGNED_${process.pid}`
const AGENT_PROMPT = `STAND_IN_AGENT_INSTRUCTIONS_${process.pid}`
// The ordinary desktop fixture authenticates /api/users/me as this account.
const USER_ID = 9001

async function waitForExecution(control, issueId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    const bindings = await requestExecutor(control, 'todos.bindings', { task_id: issueId }, 10000)
    assert.ok(bindings.length <= 1, 'One assignment created duplicate tasks')
    if (bindings[0]) {
      latest = await requestExecutor(
        control,
        'runtime.tasks.get',
        { taskId: bindings[0].task_id },
        10000
      )
      if (latest.task?.status === 'done') return latest.task
      assert.notEqual(latest.task?.status, 'failed', JSON.stringify(latest))
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`Stand-in task did not complete: ${JSON.stringify(latest)}`)
}

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs, captureScreenshot }) {
  let requests = 0
  let agentRequests = 0
  let selectionRequests = 0
  let invalidSelection = false
  const tagRequests = { review: 0, docs: 0 }
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const text = JSON.stringify(body)
      const id = `stand-in-${Date.now()}`
      const kind = codexRequestKind(body)
      if (
        text.includes('Select exactly one role for this task.') &&
        kind !== 'prewarm' &&
        kind !== 'compaction'
      ) {
        selectionRequests += 1
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(
          createSse([
            responseCreated(id),
            assistantMessage(
              invalidSelection
                ? 'invalid selection'
                : JSON.stringify({ roleId: 'docs', reason: '该任务以文档交付为主。' })
            ),
            responseCompleted(id),
          ])
        )
        return true
      }
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
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`, {
        requirements: false,
      })
      await control.command('waitFor', '[data-testid="stand-in-auto"][aria-checked="false"]')
      await captureScreenshot(
        control,
        'stand-in-02-single-role-main.png',
        '[data-testid="stand-in-dialog"]'
      )
      await control.command('click', '[data-testid="stand-in-requirements-open"]')
      await control.command('waitFor', '[data-testid="stand-in-prompt"]')
      await captureScreenshot(
        control,
        'stand-in-03-requirements.png',
        '[data-testid="stand-in-dialog"]'
      )
      assert.equal(
        await control.command(
          'getElementCount',
          '[data-testid="stand-in-open"] svg[data-state="disabled"]'
        ),
        '1'
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
            '[data-testid="stand-in-dialog"]'
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
      await captureScreenshot(control, 'stand-in-05-saved-project-status.png')
      await control.command('waitFor', `${CONTENT} [data-testid="stand-in-project-${project.id}"]`)
      assert.equal(
        await control.command(
          'getElementCount',
          '[data-testid="stand-in-open"] svg[data-state="enabled"] circle'
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
            name: '替身专用助手',
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
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`)
      await control.command('waitFor', '[data-testid="stand-in-auto"][aria-checked="true"]')
      assert.equal(await control.command('getValue', '[data-testid="stand-in-agent"]'), '')
      await control.command('waitFor', '[data-testid="stand-in-agent"] option', {
        text: '替身专用助手',
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
        '[data-testid="stand-in-dialog"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-dialog"]', { visible: false })
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
                name: `${id} 替身`,
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
          todo: { title: '同时匹配两个替身', tags: ['review', 'docs'], assignee_user_id: USER_ID },
        },
        uiTimeoutMs
      )
      for (const tagged of taggedIssues)
        await waitForExecution(control, tagged.id, modelResponseTimeoutMs)
      const selected = await waitForExecution(control, ambiguous.id, modelResponseTimeoutMs)
      const selectedTranscript = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        { taskId: selected.taskId, limit: 5 },
        uiTimeoutMs
      )
      assert.equal(
        selectedTranscript.origin.standInId,
        'review',
        'Overlapping tags must use the first matching role'
      )
      await new Promise(resolve => setTimeout(resolve, 11000))
      assert.equal(requests, 5, 'Each assignment must execute exactly once')
      assert.equal(agentRequests, 4)
      assert.deepEqual(tagRequests, { review: 2, docs: 1 }, 'Each tag must use its own prompt')
      assert.equal(
        (await requestExecutor(control, 'todos.bindings', { task_id: ambiguous.id }, uiTimeoutMs))
          .length,
        1
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
      // Create a reusable personal role through the actual shared project entry.
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`, {
        requirements: false,
      })
      await control.command('click', '[data-testid="stand-in-list-configure"]')
      await control.command('fill', '[data-testid="stand-in-role-name"]', { value: '项目协调' })
      await captureScreenshot(
        control,
        'stand-in-06-add-role.png',
        '[data-testid="stand-in-dialog"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-role-select"]')
      await captureScreenshot(
        control,
        'stand-in-07-multiple-roles.png',
        '[data-testid="stand-in-dialog"]'
      )
      await control.command('click', '[data-testid="stand-in-scheduling-open"]')
      await control.command('click', '[data-testid="stand-in-auto-select"]')
      await captureScreenshot(
        control,
        'stand-in-08-role-scheduling.png',
        '[data-testid="stand-in-dialog"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-role-select"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      await control.command('waitFor', '[data-testid="stand-in-dialog"]', { visible: false })
      let personal = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER_ID },
        uiTimeoutMs
      )
      assert.equal(personal.autoSelect, true)
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
      const aiIssue = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: {
            title: '文档说明与代码审查',
            tags: ['review', 'docs'],
            assignee_user_id: USER_ID,
          },
        },
        uiTimeoutMs
      )
      const aiTask = await waitForExecution(control, aiIssue.id, modelResponseTimeoutMs)
      const aiTranscript = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        { taskId: aiTask.taskId, limit: 5 },
        uiTimeoutMs
      )
      assert.equal(aiTranscript.origin.standInId, 'docs')
      assert.equal(aiTranscript.origin.selectionMode, 'ai')
      assert.equal(selectionRequests, 1, 'Only overlapping roles should invoke the selection model')
      assert.equal(
        (await requestExecutor(control, 'todos.bindings', { task_id: aiIssue.id }, uiTimeoutMs))
          .length,
        1
      )
      const singleIssue = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: { title: '单角色文档任务', tags: ['docs'], assignee_user_id: USER_ID },
        },
        uiTimeoutMs
      )
      await waitForExecution(control, singleIssue.id, modelResponseTimeoutMs)
      assert.equal(selectionRequests, 1, 'A single matching role must not consume selection tokens')
      invalidSelection = true
      const followingIssue = await requestExecutor(
        control,
        'todos.create',
        { project_id: project.id, todo: { title: '其他任务不受角色选择失败影响', tags: ['docs'] } },
        uiTimeoutMs
      )
      const failedIssue = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: project.id,
          todo: {
            title: '角色选择失败后的恢复',
            tags: ['review', 'docs'],
            assignee_user_id: USER_ID,
          },
        },
        uiTimeoutMs
      )
      const deadline = Date.now() + modelResponseTimeoutMs
      let failedSettings
      while (Date.now() < deadline) {
        failedSettings = await requestExecutor(
          control,
          'runtime.stand_in.personal.get',
          { userId: USER_ID },
          uiTimeoutMs
        )
        if (failedSettings.selectionErrors?.some(item => item.issueId === failedIssue.id)) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      assert.ok(
        failedSettings?.selectionErrors?.some(item => item.issueId === failedIssue.id),
        'Selection failure must be visible to the user'
      )
      await new Promise(resolve => setTimeout(resolve, 5500))
      assert.equal(
        selectionRequests,
        2,
        'A cached failure must not spend tokens on each polling cycle'
      )
      assert.equal(
        (await requestExecutor(control, 'todos.bindings', { task_id: failedIssue.id }, uiTimeoutMs))
          .length,
        0
      )
      await requestExecutor(
        control,
        'todos.update',
        {
          project_id: project.id,
          task_id: followingIssue.id,
          todo: {
            version: followingIssue.version,
            assignee_user_id: USER_ID,
            position: { before_item_id: null },
          },
        },
        uiTimeoutMs
      )
      await waitForExecution(control, followingIssue.id, modelResponseTimeoutMs)
      assert.equal(
        selectionRequests,
        2,
        'A failed decision must not block subsequent single-role assignments'
      )
      await openProjectStandIn(control, `${CONTENT} [data-testid="stand-in-open"]`, {
        requirements: false,
      })
      await control.command('waitFor', '[data-testid="stand-in-selection-errors"]', {
        text: '角色选择失败后的恢复',
      })
      await captureScreenshot(
        control,
        'stand-in-10-selection-failure-recovery.png',
        '[data-testid="stand-in-dialog"]'
      )
      invalidSelection = false
      await control.command('clickWhenEnabled', '[data-testid="stand-in-selection-retry"]')
      await waitForExecution(control, failedIssue.id, modelResponseTimeoutMs)
      assert.equal(selectionRequests, 3)
      personal = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER_ID },
        uiTimeoutMs
      )
      assert.equal(personal.selectionErrors.length, 0)
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
    },
    diagnostics() {
      return { project: PROJECT, requests, agentRequests, selectionRequests, tagRequests }
    },
  }
}
