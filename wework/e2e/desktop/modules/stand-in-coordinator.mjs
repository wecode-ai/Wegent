import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { verifyStandInScheduleActivity } from './stand-in-schedule-activity.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import {
  createLocalCollaborationProject,
  selectAgentEnvironment,
  selectAgentFormTab,
} from './workspace-flows.mjs'
import { selectE2EModel } from './shared.mjs'
import { waitForElementWidth } from './layout-metrics.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const USER = 9001
const PROJECT = `负责人上下文验证-${process.pid}`
const SCHEDULE = `已安排验证-${process.pid}`
const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'

/** Extends the registered profile checkpoint with project isolation and existing scheduling. */
export function createStandInCoordinatorVerification({
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
}) {
  return {
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      const input = JSON.stringify(body.input ?? [])
      if (
        !input.includes('PROJECT_COORDINATOR_VERIFY') &&
        !input.includes('STAND_IN_SCHEDULE_VERIFY')
      )
        return false
      const project = input.includes('PROJECT_COORDINATOR_VERIFY')
      if (project) {
        assert.ok(
          input.includes('PROJECT_A_MEMORY_ONLY'),
          'Project memory must reach the real turn'
        )
        assert.ok(
          !input.includes('PERSONAL_MEMORY_MUST_NOT_LEAK'),
          'Personal memory must remain outside project chat'
        )
        assert.ok(
          !input.includes('OTHER_PROJECT_MEMORY_MUST_NOT_LEAK'),
          'Another project must remain isolated'
        )
      }
      const id = `coordinator-verification-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(
            project
              ? input.includes('PROJECT_COORDINATOR_VERIFY_SECOND')
                ? 'PROJECT_COORDINATOR_FOLLOWUP_VERIFIED'
                : 'PROJECT_COORDINATOR_VERIFIED'
              : 'STAND_IN_SCHEDULE_VERIFIED'
          ),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await control.command('click', '[data-testid="stand-in-primary-open"]')
      assert.equal(
        (await rpc('runtime.stand_in.personal.get', { userId: USER })).primary.enabled,
        true
      )
      await openStandInSettings(control)
      await control.command('click', '[data-testid="stand-in-primary-connections-open"]')
      await openConnectionTypePicker(control)
      await control.command('click', '[data-testid="stand-in-time-connections"]')
      await control.command('waitFor', '[data-testid="stand-in-calendar-connection"]')
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-work-view-scheduled"]'),
        '0'
      )
      await control.command(
        'clickWhenEnabled',
        '[data-testid="stand-in-processing-settings-toggle"]'
      )
      await control.command('click', '[data-testid="stand-in-calendar-policy"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
      await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
        visible: false,
      })
      await openStandInSettings(control)
      await control.command('click', '[data-testid="stand-in-primary-connections-open"]')
      await openConnectionTypePicker(control)
      await control.command('click', '[data-testid="stand-in-time-connections"]')
      await control.command('click', '[data-testid="create-automation-button"]')
      await control.command('click', '[data-testid="automation-save-button"]')
      await control.command('waitFor', '[data-testid="automation-draft-error"]', {
        text: '请填写名称和任务说明',
      })
      await captureScreenshot(control, '22b-calendar-invalid-draft-preserved.png')
      await control.command('fill', '[data-testid="automation-name-input"]', { value: SCHEDULE })
      await control.command('fill', '[data-testid="automation-prompt-input"]', {
        value: 'STAND_IN_SCHEDULE_VERIFY',
      })
      assert.equal(
        await control.command('getElementCount', '[data-testid="automation-model-select"]'),
        '0'
      )
      assert.equal(
        await control.command('getElementCount', '[data-testid="automation-draft-error"]'),
        '0'
      )
      await captureScreenshot(control, '23-schedule-inherits-stand-in.png')
      await control.command('click', '[data-testid="stand-in-connections-back"]')
      await control.command('waitFor', '[data-testid="automation-discard"]')
      await captureScreenshot(control, '23b-schedule-unsaved-navigation.png')
      await control.command('click', '[data-testid="automation-keep-editing"]')
      assert.equal(
        await control.command('getValue', '[data-testid="automation-prompt-input"]'),
        'STAND_IN_SCHEDULE_VERIFY'
      )
      await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]')
      await control.command('waitFor', '[data-testid="automation-save-button"]', { visible: false })
      assert.equal(
        await control.command('getElementCount', '[data-testid="automation-error"]'),
        '0'
      )
      const schedules = await rpc('runtime.automations.list', {})
      const schedule = schedules.items.find(row => row.name === SCHEDULE)
      assert.deepEqual(schedule.taskRequest.standInOwner, { userId: USER, roleId: '@primary' })
      assert.equal(schedule.taskPayload.executionRequest, undefined)
      await control.command('click', `[data-testid="automation-open-${schedule.id}"]`)
      await control.command('fill', '[data-testid="automation-name-input"]', {
        value: `${SCHEDULE}（已调整）`,
      })
      await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]')
      await control.command('waitFor', '[data-testid="automation-save-button"]', { visible: false })
      assert.equal(
        (await rpc('runtime.automations.list', {})).items.find(row => row.id === schedule.id).name,
        `${SCHEDULE}（已调整）`
      )
      await control.command('click', `[data-testid="automation-open-${schedule.id}"]`)
      await control.command('click', `[data-testid="automation-detail-toggle-${schedule.id}"]`)
      await control.command('waitFor', '[data-testid="automation-detail-panel"]', {
        text: '已暂停',
      })
      assert.equal(
        (await rpc('runtime.automations.list', {})).items.find(row => row.id === schedule.id)
          .enabled,
        false
      )
      await captureScreenshot(control, '23c-calendar-updated-and-paused.png')
      await control.command('click', `[data-testid="automation-detail-toggle-${schedule.id}"]`)
      await control.command('waitFor', '[data-testid="automation-detail-panel"]', { text: '活跃' })
      await control.command('click', `[data-testid="automation-detail-actions-${schedule.id}"]`)
      await control.command('click', '[data-testid="automation-run-now-button"]')
      await control.command('waitFor', '[data-testid="automation-run-history"]', {
        text: '已完成',
        timeoutMs: modelResponseTimeoutMs,
      })
      const runs = await rpc('runtime.automation_runs.list', { automationId: schedule.id })
      assert.ok(runs.items.some(row => row.status === 'succeeded'))
      await captureScreenshot(control, '24-schedule-executed.png')
      const run = runs.items.find(row => row.status === 'succeeded')
      await control.command('click', `[data-testid="automation-run-open-${run.id}"]`)
      await control.command('waitFor', 'body', {
        text: 'STAND_IN_SCHEDULE_VERIFIED',
        timeoutMs: modelResponseTimeoutMs,
      })
      await captureScreenshot(control, '24b-calendar-result-in-original-work.png')
      await verifyStandInScheduleActivity(control, rpc, schedule, captureScreenshot)

      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await openStandInSettings(control)
      const preferences = await control.command('getValue', '[data-testid="stand-in-preferences"]')
      await control.command('fill', '[data-testid="stand-in-preferences"]', {
        value: `${preferences}\n保留这份说明草稿`,
      })
      await control.command('click', '[data-testid="stand-in-primary-connections-open"]')
      await openConnectionTypePicker(control)
      await control.command('click', '[data-testid="stand-in-time-connections"]')
      const savedSchedules = (await rpc('runtime.automations.list', {})).items
      await control.command('click', '[data-testid="create-automation-button"]')
      await control.command('fill', '[data-testid="automation-name-input"]', {
        value: '不保存的日历草稿',
      })
      await control.command('click', '[data-testid="stand-in-primary-profile-close"]')
      await control.command('click', '[data-testid="automation-discard"]')
      await control.command('waitFor', '[data-testid="stand-in-primary-keep-editing"]')
      await captureScreenshot(control, '24b2-separate-calendar-and-settings-drafts.png')
      await control.command('click', '[data-testid="stand-in-primary-keep-editing"]')
      assert.equal(
        await control.command('getElementCount', '[data-testid="automation-name-input"]'),
        '0'
      )
      const remainingSchedules = (await rpc('runtime.automations.list', {})).items
      assert.deepEqual(
        remainingSchedules.map(({ id, name }) => ({ id, name })),
        savedSchedules.map(({ id, name }) => ({ id, name }))
      )
      assert.ok(!remainingSchedules.some(row => row.name === '不保存的日历草稿'))
      await control.command('click', '[data-testid="stand-in-connections-back"]')
      await control.command('click', '[data-testid="stand-in-primary-back-to-settings"]')
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-preferences"]'),
        `${preferences}\n保留这份说明草稿`
      )
      await control.command('click', '[data-testid="stand-in-primary-profile-close"]')
      await control.command('click', '[data-testid="stand-in-primary-discard"]')
      const role = (await rpc('runtime.stand_in.personal.get', { userId: USER })).roles[0]
      assert.ok(role, 'The preceding lifecycle leaves one recreated role')
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('waitFor', '[data-testid="appearance-settings-page"]', {
        timeoutMs: 30_000,
      })
      await control.command('clickWhenEnabled', '[data-testid="appearance-mode-dark"]', {
        timeoutMs: 30_000,
      })
      await control.command('waitFor', 'html[data-theme="dark"]', { timeoutMs: 30_000 })
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('click', `[data-testid="stand-in-overview-role-${role.id}"]`)
      await openStandInSettings(control)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-connections-open"]')
      await openConnectionTypePicker(control)
      await control.command('click', '[data-testid="stand-in-time-connections"]')
      await control.command('waitFor', '[data-testid="stand-in-calendar-empty"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="stand-in-processing-settings-toggle"]'
      )
      await control.command('waitFor', '[data-testid="stand-in-calendar-policy"]')
      await control.command('waitFor', '[data-testid="stand-in-save"]')
      const previousWindowSize = JSON.parse(
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 960, height: 720 }),
        })
      )
      const viewport = await waitForElementWidth(
        control,
        'body',
        width => width <= 960 && width >= 800,
        'compact calendar window'
      )
      await captureScreenshot(control, '24c1-role-calendar-dark-compact.png')
      await control.command('click', '[data-testid="create-automation-button"]')
      assert.equal(await control.command('getElementCount', '[data-testid="stand-in-save"]'), '0')
      await control.command('fill', '[data-testid="automation-name-input"]', {
        value: '角色的安排草稿',
      })
      await control.command('click', '[data-testid="stand-in-close"]')
      await control.command('waitFor', '[data-testid="automation-discard"]')
      await control.command('click', '[data-testid="automation-keep-editing"]')
      assert.equal(
        await control.command('getValue', '[data-testid="automation-name-input"]'),
        '角色的安排草稿'
      )
      await captureScreenshot(control, '24c-role-calendar-draft-kept.png')
      const panel = JSON.parse(
        await control.command('getElementMetrics', '[data-testid="automation-detail-panel"]')
      )[0]
      assert.ok(
        panel.left >= viewport.left && panel.right <= viewport.right,
        'The calendar editor fits the compact window horizontally'
      )
      await control.command('click', '[data-testid="stand-in-close"]')
      await control.command('click', '[data-testid="automation-discard"]')
      await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', { visible: false })
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify(previousWindowSize),
      })
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('waitFor', '[data-testid="appearance-settings-page"]')
      await control.command('clickWhenEnabled', '[data-testid="appearance-mode-light"]')
      await control.command('waitFor', 'html[data-theme="light"]')
      await rpc('runtime.automations.delete', { automationId: schedule.id })

      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      const projects = await rpc('projects.list', {})
      const project = projects.find(row => row.name === PROJECT)
      assert.ok(project)
      // Create through the same UI producer as a user so the group contract is complete.
      await control.command('clickWhenEnabled', '[data-testid="project-coordinator-open"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="project-coordinator-configure-group"]'
      )
      await control.command(
        'clickWhenEnabled',
        `${CONTENT} [data-testid="collaboration-group-open-create"]`
      )
      await control.command('fill', `${CONTENT} [data-testid="collaboration-group-name"]`, {
        value: '交付小组',
      })
      await control.command(
        'clickWhenEnabled',
        `${CONTENT} [data-testid="collaboration-group-create-add-members"]`
      )
      await control.command(
        'clickWhenEnabled',
        '[data-testid="collaboration-group-agent-action-create"]'
      )
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]')
      await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
        value: '项目负责人',
      })
      await selectAgentFormTab(control, 'cloud-project-chat-agent-editor', 'runtime', uiTimeoutMs)
      await selectAgentEnvironment(
        control,
        'cloud-project-chat-agent-environment',
        'policy:user_select',
        uiTimeoutMs
      )
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-model"]:enabled')
      await control.command('select', '[data-testid="cloud-project-chat-agent-model"]', {
        value: 'user_select',
      })
      await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]')
      await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
        visible: false,
      })
      const agent = (await rpc('chat_agents.list', { project_id: project.id })).find(
        row => row.display_name === '项目负责人' || row.name === '项目负责人'
      )
      assert.ok(agent, 'Creating an agent through the group editor persists the real agent')
      await control.command(
        'waitFor',
        `${CONTENT} [data-testid="collaboration-group-leader-agent-${agent.id}"]`
      )
      await control.command('waitFor', `${CONTENT} [data-testid="collaboration-group-leader"]`, {
        text: '项目负责人',
      })
      await control.command(
        'clickWhenEnabled',
        `${CONTENT} [data-testid="collaboration-group-create"]`
      )
      await control.command('waitFor', `${CONTENT} [data-testid^="collaboration-group-detail-"]`, {
        text: '交付小组',
      })
      const configured = (await rpc('projects.list', {})).find(row => row.id === project.id)
      const group = configured.metadata.collaboration_groups.find(row => row.name === '交付小组')
      assert.equal(group.leader.id, agent.id)
      assert.deepEqual(group.stages, [])
      await captureScreenshot(control, '25a-existing-leader-created-through-group-settings.png')
      await control.command(
        'clickWhenEnabled',
        `${CONTENT} [data-testid="collaboration-tab-board"]`
      )
      const other = await rpc('projects.create', { name: '隔离项目' })
      for (const [scope, content] of [
        [{ kind: 'personal' }, 'PERSONAL_MEMORY_MUST_NOT_LEAK'],
        [{ kind: 'project_coordinator', id: project.id, store: 'local' }, 'PROJECT_A_MEMORY_ONLY'],
        [
          { kind: 'project_coordinator', id: other.id, store: 'local' },
          'OTHER_PROJECT_MEMORY_MUST_NOT_LEAK',
        ],
      ]) {
        await rpc('runtime.stand_in.memory.save', { userId: USER, memory: { scope, content } })
      }
      const first = await rpc('runtime.project_coordinator.conversation', {
        userId: USER,
        projectId: project.id,
        projectStore: 'local',
        groupId: group.id,
      })
      const secondUser = await rpc('runtime.project_coordinator.conversation', {
        userId: USER + 1,
        projectId: project.id,
        projectStore: 'local',
        groupId: group.id,
      })
      assert.notEqual(first.taskId, secondUser.taskId)
      await captureScreenshot(control, '25-project-coordinator-entry.png')
      await control.command('click', '[data-testid="project-coordinator-open"]')
      await control.command('waitFor', '[data-testid="project-coordinator-chat"]')
      const chat = '[data-testid="project-coordinator-chat"]'
      await selectE2EModel(control, undefined, undefined, chat)
      const selectedModelLabel = await control.command(
        'getText',
        `${chat} [data-testid="model-selector-button"]`
      )
      assert.ok(!selectedModelLabel.includes('选择模型'))
      await captureScreenshot(control, '26-project-private-chat.png')
      await control.command('fill', `${chat} [data-testid="chat-message-input"]`, {
        value: 'PROJECT_COORDINATOR_VERIFY',
      })
      await control.command('clickWhenEnabled', `${chat} [data-testid="send-message-button"]`)
      await control.command('waitFor', chat, {
        text: 'PROJECT_COORDINATOR_VERIFIED',
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', `${chat} [data-testid="model-selector-button"]`, {
        text: selectedModelLabel,
      })
      await captureScreenshot(control, '27-project-reply.png')
      const firstTurn = await rpc('runtime.tasks.get', { taskId: first.taskId })
      assert.ok(
        firstTurn.task.runtimeHandle.modelSelection?.modelName,
        'The selected cloud or runtime model must persist'
      )
      const thread = firstTurn.task.runtimeHandle.threadId
      assert.ok(thread)
      await control.command('fill', `${chat} [data-testid="chat-message-input"]`, {
        value: 'PROJECT_COORDINATOR_VERIFY_SECOND',
      })
      await control.command('clickWhenEnabled', `${chat} [data-testid="send-message-button"]`)
      await control.command('waitFor', chat, {
        text: 'PROJECT_COORDINATOR_FOLLOWUP_VERIFIED',
        timeoutMs: modelResponseTimeoutMs,
      })
      const secondTurn = await rpc('runtime.tasks.get', { taskId: first.taskId })
      assert.equal(
        secondTurn.task.runtimeHandle.threadId,
        thread,
        'Project follow-ups must keep the original thread'
      )
      assert.equal(
        secondTurn.task.runtimeHandle.modelSelection.modelName,
        firstTurn.task.runtimeHandle.modelSelection.modelName,
        'Follow-up must preserve the selected model'
      )
      await control.command('waitFor', `${chat} [data-testid="model-selector-button"]`, {
        text: selectedModelLabel,
      })
      await captureScreenshot(control, '27b-project-followup-same-thread.png')

      await control.command('click', '[data-testid="project-coordinator-memory"]')
      await control.command('waitFor', '[data-testid="stand-in-memory-panel"]', {
        text: 'PROJECT_A_MEMORY_ONLY',
      })
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-memory-edit"]'),
        '1'
      )
      await captureScreenshot(control, '28-project-memory-isolated.png')
      await control.command('click', '[data-testid="stand-in-memory-close"]')
      await control.command('click', '[data-testid="project-coordinator-work-list"]')
      await control.command('waitFor', '[data-testid="project-coordinator-dialog"]', {
        visible: false,
      })
      await control.command('waitFor', '[data-testid="cloud-project-header-title"]', {
        text: PROJECT,
      })
      await captureScreenshot(control, '29-back-to-project-work.png')
      await control.command('click', '[data-testid="project-coordinator-open"]')
      await control.command('waitFor', '[data-testid="project-coordinator-dialog"] h2', {
        text: '交付小组 · 项目负责人',
      })
      await control.command('click', '[data-testid="project-coordinator-settings"]')
      await control.command('waitFor', `[data-testid="collaboration-group-${group.id}"]`, {
        text: '项目负责人',
      })
      await captureScreenshot(control, '30-existing-group-leader-settings.png')
    },
  }
}
