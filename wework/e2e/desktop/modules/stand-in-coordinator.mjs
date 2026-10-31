import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { createLocalCollaborationProject } from './workspace-flows.mjs'
import { selectE2EModel } from './shared.mjs'
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
      await control.command('click', '[data-testid="stand-in-settings-open"]')
      await control.command('click', '[data-testid="stand-in-primary-enabled"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
      await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
        visible: false,
      })
      await control.command('click', '[data-testid="stand-in-role-chat"]')
      await control.command('click', '[data-testid="stand-in-work-view-scheduled"]')
      await control.command('click', '[data-testid="create-automation-button"]')
      await control.command('fill', '[data-testid="automation-name-input"]', { value: SCHEDULE })
      await control.command('fill', '[data-testid="automation-prompt-input"]', {
        value: 'STAND_IN_SCHEDULE_VERIFY',
      })
      assert.equal(
        await control.command('getElementCount', '[data-testid="automation-model-select"]'),
        '0'
      )
      await captureScreenshot(control, '23-schedule-inherits-stand-in.png')
      await control.command('click', '[data-testid="stand-in-work-view-work"]')
      await control.command('waitFor', '[data-testid="automation-discard"]')
      await captureScreenshot(control, '23b-schedule-unsaved-navigation.png')
      await control.command('click', '[data-testid="automation-keep-editing"]')
      assert.equal(
        await control.command('getValue', '[data-testid="automation-prompt-input"]'),
        'STAND_IN_SCHEDULE_VERIFY'
      )
      await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]')
      await control.command('waitFor', '[data-testid="automation-save-button"]', { visible: false })
      const schedules = await rpc('runtime.automations.list', {})
      const schedule = schedules.items.find(row => row.name === SCHEDULE)
      assert.deepEqual(schedule.taskRequest.standInOwner, { userId: USER, roleId: '@primary' })
      assert.equal(schedule.taskPayload.executionRequest, undefined)
      await control.command('click', `[data-testid="automation-detail-actions-${schedule.id}"]`)
      await control.command('click', '[data-testid="automation-run-now-button"]')
      await control.command('waitFor', '[data-testid="automation-run-history"]', {
        text: '已完成',
        timeoutMs: modelResponseTimeoutMs,
      })
      const runs = await rpc('runtime.automation_runs.list', { automationId: schedule.id })
      assert.ok(runs.items.some(row => row.status === 'succeeded'))
      await captureScreenshot(control, '24-schedule-executed.png')
      await rpc('runtime.automations.delete', { automationId: schedule.id })

      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      const projects = await rpc('projects.list', {})
      const project = projects.find(row => row.name === PROJECT)
      assert.ok(project)
      const agent = await rpc('chat_agents.create', {
        project_id: project.id,
        agent: {
          name: '项目负责人',
          runtime: 'codex',
          model: 'auto',
          execution_policy: { mode: 'user_select' },
          model_policy: { mode: 'user_select' },
        },
      })
      const group = {
        id: 'coordinator-group',
        name: '交付小组',
        leader: { kind: 'agent', id: agent.id, name: agent.name },
        members: [{ kind: 'agent', id: agent.id }],
      }
      await rpc('projects.update', {
        project_id: project.id,
        project: { version: project.version, collaboration_groups: [group] },
      })
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
    },
  }
}
