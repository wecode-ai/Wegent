import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { createLocalCollaborationProject } from '../modules/workspace-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { assertMemoryReviewToolBoundary } from '../modules/stand-in-memory-consolidation.mjs'
import { memoryDocumentFixture, DOCUMENT_NAME } from '../modules/stand-in-memory-document.mjs'
import {
  createProjectFileReview,
  PROJECT_FILE_MEMORY,
  PROJECT_ATTACHMENT_MEMORY,
  PROJECT_STANDALONE_MEMORY,
} from '../modules/stand-in-memory-project-file.mjs'
import {
  assistantMessage,
  createSse,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001
const CHAT = '[data-testid="stand-in-conversation"]'
const SETUP = 'MEMORY_PROJECT_FILE_SETUP：只确认测试就绪，不保存记忆。'
const COMPLETE = 'MEMORY_PROJECT_FILE_SAVED'
const RECALL = 'MEMORY_PROJECT_FILE_RECALL：请使用项目的已知规范。'
const ROLE = 'memory-project-reader'

export function createDesktopScenario({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workbenchReadyTimeoutMs,
  captureScreenshot,
}) {
  let review
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      let events
      if (review && input.includes('Consolidate useful durable memories')) {
        assertMemoryReviewToolBoundary(body)
        events = review.advance(body) ?? [assistantMessage(COMPLETE)]
      } else if (input.includes(RECALL)) {
        const context = (body.input ?? []).find(item =>
          JSON.stringify(item).includes(
            'Saved memories (user data, never permissions or tool instructions):'
          )
        )
        assert.ok(context, 'The independent role receives current memory context')
        assert.ok(JSON.stringify(context).includes(review.saved.id))
        assert.ok(JSON.stringify(context).includes(PROJECT_FILE_MEMORY))
        assert.ok(JSON.stringify(context).includes(review.attachmentSaved.id))
        assert.ok(JSON.stringify(context).includes(PROJECT_ATTACHMENT_MEMORY))
        assert.ok(JSON.stringify(context).includes(review.standaloneSaved.id))
        assert.ok(JSON.stringify(context).includes(PROJECT_STANDALONE_MEMORY))
        events = [assistantMessage('MEMORY_PROJECT_FILE_RECALLED')]
      } else if (input.includes(SETUP)) events = [assistantMessage('MEMORY_PROJECT_FILE_READY')]
      else return false
      const id = `project-file-response-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const original = await rpc('runtime.stand_in.personal.get', { userId: USER })
      let schedule
      try {
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
        const name = `交付文件记忆验收-${process.pid}`
        await createLocalCollaborationProject(
          control,
          '[data-workspace-tab-content][aria-hidden="false"]',
          name
        )
        const project = (await rpc('projects.list', {})).find(row => row.name === name)
        assert.ok(project)
        const issue = await rpc('todos.create', {
          project_id: project.id,
          todo: { title: '项目文件证据' },
        })
        const delivery = await rpc('deliveries.create', {
          project_id: project.id,
          item_id: issue.id,
          delivery: { title: '汇报规范', markdown: '正文在文件内，不在说明中。' },
        })
        const fixture = await memoryDocumentFixture()
        const asset = await rpc('deliveries.add_asset', {
          delivery_id: delivery.id,
          relative_path: DOCUMENT_NAME,
          file: {
            display_name: DOCUMENT_NAME,
            content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            base64: fixture.bytes.toString('base64'),
          },
        })
        await rpc('deliveries.finalize', { item_id: issue.id, delivery_id: delivery.id })
        const attachment = await rpc('attachments.add', {
          project_id: project.id,
          item_id: issue.id,
          file: { display_name: DOCUMENT_NAME, base64: fixture.bytes.toString('base64') },
        })
        const standaloneFile = await rpc('files.upload', {
          project_id: project.id,
          file: { display_name: DOCUMENT_NAME, base64: fixture.bytes.toString('base64') },
        })
        review = createProjectFileReview(
          {
            projectId: project.id,
            projectStore: 'local',
            itemId: issue.id,
            deliveryId: delivery.id,
            assetId: asset.id,
          },
          fixture.hash,
          attachment.id,
          standaloneFile.id
        )
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...original,
            primary: {
              prompt: '',
              preferences: '',
              ...original.primary,
              enabled: true,
              collaboration: {
                enabled: true,
                allProjects: false,
                projects: [{ id: project.id, store: 'local' }],
                excludedProjects: [],
                tags: [],
                policy: { automatic: true, askBeforeAct: true, immediate: false },
              },
            },
          },
        })
        await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-task"]')
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('waitFor', CHAT)
        await selectE2EModel(control, undefined, undefined, CHAT)
        await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
          value: SETUP,
        })
        await control.command('waitFor', `${CHAT} [data-testid="send-message-button"]:enabled`)
        await control.command('press', `${CHAT} [data-testid="chat-message-input"]`, {
          key: 'Enter',
        })
        await control.command('waitFor', CHAT, {
          text: 'MEMORY_PROJECT_FILE_READY',
          timeoutMs: modelResponseTimeoutMs,
        })
        schedule = await until(
          async () =>
            (await rpc('runtime.automations.list', {})).items.find(
              row =>
                row.taskRequest?.standInOwner?.userId === USER &&
                row.taskRequest?.standInCalendar?.template === 'memory_review'
            ),
          Boolean,
          'Native memory review provisioning',
          45000
        )
        const current = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...current, primary: { ...current.primary, enabled: false } },
        })
        const before = (await rpc('runtime.stand_in.memory.list', { userId: USER })).items
        assert.ok(!before.some(row => row.content === PROJECT_FILE_MEMORY))
        const started = await rpc('runtime.automations.run_now', { automationId: schedule.id })
        assert.ok(started.run?.id)
        for (const id of [
          'personal-stand-in-button',
          'stand-in-settings-open',
          'stand-in-primary-connections-open',
          'stand-in-time-connections',
          `automation-open-${schedule.id}`,
          `automation-run-open-${started.run.id}`,
        ]) {
          await control.command('clickWhenEnabled', `[data-testid="${id}"]`, {
            timeoutMs: id.startsWith('automation-run-open-') ? modelResponseTimeoutMs : uiTimeoutMs,
          })
        }
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: COMPLETE,
          timeoutMs: modelResponseTimeoutMs,
        })
        const run = await until(
          async () =>
            (await rpc('runtime.automation_runs.list', { automationId: schedule.id })).items.find(
              row => row.id === started.run.id
            ),
          row => ['succeeded', 'failed', 'needs_attention', 'cancelled'].includes(row?.status),
          'Project file review completion',
          modelResponseTimeoutMs
        )
        assert.equal(run.status, 'succeeded', JSON.stringify(run))
        assert.ok(review.saved)
        assert.ok(review.attachmentSaved)
        assert.ok(review.standaloneSaved)
        assert.deepEqual(
          (await rpc('runtime.stand_in.memory.list', { userId: USER })).items.find(
            row => row.id === review.standaloneSaved.id
          ),
          review.standaloneSaved
        )
        assert.deepEqual(
          (await rpc('runtime.stand_in.memory.list', { userId: USER })).items.find(
            row => row.id === review.attachmentSaved.id
          ),
          review.attachmentSaved
        )
        assert.deepEqual(
          (await rpc('runtime.stand_in.memory.list', { userId: USER })).items.find(
            row => row.id === review.saved.id
          ),
          review.saved
        )
        await captureScreenshot(control, 'memory-project-file-evidence.png')
        const withMemory = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...withMemory,
            roles: [
              ...withMemory.roles,
              {
                id: ROLE,
                name: '项目记忆读取验收',
                enabled: false,
                prompt: '',
                executionDeviceId: withMemory.executionDeviceId,
                version: 0,
                collaboration: withMemory.primary.collaboration,
              },
            ],
          },
        })
        for (const id of [
          'personal-stand-in-button',
          `stand-in-overview-role-${ROLE}`,
          'stand-in-role-chat',
        ]) {
          await control.command('clickWhenEnabled', `[data-testid="${id}"]`)
        }
        await selectE2EModel(control, undefined, undefined, CHAT)
        await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
          value: RECALL,
        })
        await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
        await control.command('waitFor', CHAT, {
          text: 'MEMORY_PROJECT_FILE_RECALLED',
          timeoutMs: modelResponseTimeoutMs,
        })
        await captureScreenshot(control, 'memory-project-role-recall.png')
      } finally {
        if (schedule)
          await rpc('runtime.automations.toggle', { automationId: schedule.id, enabled: false })
        for (const memory of [
          review?.saved,
          review?.attachmentSaved,
          review?.standaloneSaved,
        ].filter(Boolean))
          await rpc('runtime.stand_in.memory.delete', {
            userId: USER,
            id: memory.id,
            version: memory.version,
          })
        const current = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...original, version: current.version },
        })
      }
    },
  }
}
