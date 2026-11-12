import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { createLocalCollaborationProject } from '../modules/workspace-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001
const PROJECT = `项目明确发布-${process.pid}`
const PRIVATE = 'PRIVATE_COORDINATOR_CONCLUSION_MUST_NOT_BE_SHARED'
const DRAFT = 'PRIVATE_UNSENT_DRAFT_MUST_REMAIN'
const PUBLIC = '明确发布：本轮先完成权限隔离验证，再安排实施。'
const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const CHAT = '[data-testid="project-coordinator-chat"]'

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, modelResponseTimeoutMs }) {
  let modelTurns = 0
  return {
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      if (!input.includes('PROJECT_PRIVATE_PUBLICATION_VERIFY')) return false
      assert.ok(
        input.includes('PRIVATE_PROJECT_MEMORY'),
        'The bound private project memory is available'
      )
      assert.ok(!input.includes('UNRELATED_PERSONAL_MEMORY'), 'Personal memory stays isolated')
      modelTurns++
      const id = `project-private-publication-${modelTurns}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([responseCreated(id), assistantMessage(PRIVATE), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      const project = (await rpc('projects.list', {})).find(row => row.name === PROJECT)
      assert.ok(project)
      const agent = await rpc('chat_agents.create', {
        project_id: project.id,
        agent: {
          name: '发布验证负责人',
          runtime: 'codex',
          model: 'auto',
          execution_policy: { mode: 'user_select' },
          model_policy: { mode: 'user_select' },
        },
      })
      const group = {
        id: 'publication-group',
        name: '项目交付组',
        leader: { kind: 'agent', id: agent.id, name: agent.name },
        members: [{ kind: 'agent', id: agent.id }],
      }
      await rpc('projects.update', {
        project_id: project.id,
        project: { version: project.version, collaboration_groups: [group] },
      })
      const issue = await rpc('todos.create', {
        project_id: project.id,
        todo: { title: '共享结论记录' },
      })
      const foreignProject = await rpc('projects.create', { name: `发布隔离-${process.pid}` })
      await rpc('todos.create', {
        project_id: foreignProject.id,
        todo: { title: 'OTHER_PROJECT_MUST_NOT_BE_AN_OPTION' },
      })
      for (const [scope, content] of [
        [{ kind: 'project_coordinator', id: project.id, store: 'local' }, 'PRIVATE_PROJECT_MEMORY'],
        [{ kind: 'personal' }, 'UNRELATED_PERSONAL_MEMORY'],
      ])
        await rpc('runtime.stand_in.memory.save', { userId: USER, memory: { scope, content } })
      const conversation = await rpc('runtime.project_coordinator.conversation', {
        userId: USER,
        projectId: project.id,
        projectStore: 'local',
        groupId: group.id,
      })
      const otherUser = await rpc('runtime.project_coordinator.conversation', {
        userId: USER + 1,
        projectId: project.id,
        projectStore: 'local',
        groupId: group.id,
      })
      assert.notEqual(conversation.taskId, otherUser.taskId)
      await control.command('waitFor', '[data-testid="project-coordinator-open"]')
      await captureScreenshot(control, 'publication-01-project-entry.png')
      await control.command('click', '[data-testid="project-coordinator-open"]')
      await control.command('waitFor', CHAT)
      await selectE2EModel(control, undefined, undefined, CHAT)
      await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
        value: 'PROJECT_PRIVATE_PUBLICATION_VERIFY',
      })
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
      await control.command('waitFor', CHAT, { text: PRIVATE, timeoutMs: modelResponseTimeoutMs })
      const comments = () =>
        rpc('todos.comment.list', { project_id: project.id, task_id: issue.id })
      assert.equal(
        (await comments()).length,
        0,
        'Private chat and memory must not publish implicitly'
      )
      await captureScreenshot(control, 'publication-02-private-conversation.png')
      await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, { value: DRAFT })
      await control.command('click', '[data-testid="project-coordinator-publish"]')
      await control.command('waitFor', '[data-testid="project-coordinator-publication-target"]', {
        text: issue.title,
      })
      assert.equal(
        await control.command(
          'getValue',
          '[data-testid="project-coordinator-publication-content"]'
        ),
        ''
      )
      assert.ok(
        !(
          await control.command('getText', '[data-testid="project-coordinator-publication-target"]')
        ).includes('OTHER_PROJECT_MUST_NOT_BE_AN_OPTION')
      )
      await captureScreenshot(control, 'publication-03-explicit-publication-entry.png')
      await control.command(
        'select',
        '[data-testid="project-coordinator-publication-target"]',
        { value: issue.id }
      )
      await control.command('fill', '[data-testid="project-coordinator-publication-content"]', {
        value: PUBLIC,
      })
      await control.command('click', '[data-testid="project-coordinator-publication-cancel"]')
      await control.command('waitFor', '[data-testid="project-coordinator-publication-keep"]')
      await captureScreenshot(control, 'publication-04-unsent-content-confirmation.png')
      await control.command('click', '[data-testid="project-coordinator-publication-keep"]')
      assert.equal((await comments()).length, 0)
      assert.equal(
        await control.command(
          'getValue',
          '[data-testid="project-coordinator-publication-content"]'
        ),
        PUBLIC
      )
      await captureScreenshot(control, 'publication-05-selected-issue-and-content.png')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="project-coordinator-publication-submit"]'
      )
      await control.command('waitFor', '[data-testid="project-coordinator-published"]', {
        text: issue.title,
      })
      const shared = await comments()
      assert.equal(shared.length, 1)
      assert.equal(shared[0].content, PUBLIC)
      assert.ok(!JSON.stringify(shared).includes(PRIVATE))
      assert.ok(!JSON.stringify(shared).includes(DRAFT))
      assert.ok(!JSON.stringify(shared).includes('PRIVATE_PROJECT_MEMORY'))
      assert.equal(modelTurns, 1, 'Publishing must not wake another AI execution')
      await captureScreenshot(control, 'publication-06-shared-record-created.png')
      await control.command('click', '[data-testid="project-coordinator-publication-close"]')
      assert.equal(
        await control.command('getValue', `${CHAT} [data-testid="chat-message-input"]`),
        DRAFT
      )
      await control.command('waitFor', CHAT, { text: PRIVATE })
      await captureScreenshot(control, 'publication-07-private-draft-preserved.png')
      await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, { value: '' })
      await control.command('click', '[data-testid="project-coordinator-work-list"]')
      await control.command('waitFor', '[data-testid="project-coordinator-dialog"]', {
        visible: false,
      })
      await control.command('click', `[data-testid="cloud-todo-card-${issue.id}"]`)
      await control.command('waitFor', `${CONTENT} [data-testid="collaboration-issue-detail"]`, {
        text: PUBLIC,
      })
      await captureScreenshot(control, 'publication-08-original-issue-comment.png')
    },
  }
}
