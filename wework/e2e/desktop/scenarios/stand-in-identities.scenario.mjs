import {
  openStandInSettings,
  openStandInActivity,
  openStandInDetails,
} from '../modules/stand-in-profile-navigation.mjs'
import { createStandInDingTalkFixture } from '../modules/stand-in-dingtalk-fixture.mjs'
import { createStandInProposalRegression } from '../modules/stand-in-proposal-regression.mjs'
import { openConnectionTypePicker } from '../modules/stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const ROOT = '[data-testid="stand-in-overview"]'
const CHAT = `${ROOT} [data-testid="stand-in-conversation"]`
const INPUT = `${CHAT} [data-testid="chat-message-input"]`
const USER = 9001
const ROLE = 'identity-reviewer'
const PROPOSE = 'IDENTITY_CREATE_REVIEW_ROLE'
const FOLLOWUP = 'IDENTITY_FOLLOW_UP'

export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workspacePath,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  const fixture = createStandInDingTalkFixture({ resultDir, uiTimeoutMs, workbenchReadyTimeoutMs })
  const proposalRegression = createStandInProposalRegression({
    uiTimeoutMs,
    modelResponseTimeoutMs,
    captureScreenshot,
  })
  let draft
  let sentProposal = false
  const requests = []
  return {
    prepareApp: fixture.prepareApp,
    async handleHttp(req, response, url) {
      if (await proposalRegression.handleHttp(req, response, url)) return true
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (
        isReplyPredictionRequest(body) ||
        ['prewarm', 'compaction'].includes(codexRequestKind(body))
      )
        return false
      const input = JSON.stringify(body.input ?? [])
      if (!input.includes(PROPOSE) && !input.includes(FOLLOWUP)) return false
      requests.push(input.includes(FOLLOWUP) ? 'followup' : 'proposal')
      const id = `identity-${Date.now()}`
      let events
      if (input.includes(FOLLOWUP))
        events = [assistantMessage('已记住这次补充，我们继续在同一个分身会话沟通。')]
      else if (requestContainsToolOutput(body, 'identity-proposal'))
        events = [assistantMessage('已拟好评审角色，请查看并确认上方的变更。确认后才会生效。')]
      else {
        const tool = mcpToolRequestEvents(body, {
          toolName: 'propose_profile',
          directToolName: 'mcp__wework_stand_in__propose_profile',
          argumentsValue: {
            summary: '创建负责评审的场景角色，默认由你手动交办。',
            settings: draft,
          },
          searchCallId: 'identity-search',
          toolCallId: 'identity-proposal',
        })
        events = tool.events
        if (requests.length === 1) {
          const receipt = assistantMessage('收到，我来拟定评审角色。')
          receipt.item.phase = 'commentary'
          const progress = assistantMessage('IDENTITY_INTERNAL_PROGRESS_MUST_STAY_HIDDEN')
          progress.item.phase = 'commentary'
          events = [receipt, progress, ...events]
        }
        if (tool.mode === 'direct') sentProposal = true
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await fixture.install(control)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('waitFor', CHAT)
      const initial = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER },
        uiTimeoutMs
      )
      assert.equal(
        (
          await requestExecutor(
            control,
            'runtime.stand_in.work.list',
            { userId: USER },
            uiTimeoutMs
          )
        ).items.length,
        0
      )
      await captureScreenshot(control, '01-primary-conversation.png', ROOT)
      await openStandInSettings(control)
      await control.command('fill', '[data-testid="stand-in-preferences"]', {
        value: '回复简洁；需要决策时先问我。',
      })
      await captureScreenshot(control, '02-primary-editable-preferences.png', ROOT)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
      await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
        visible: false,
      })
      const saved = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: USER },
        uiTimeoutMs
      )
      assert.equal(saved.primary.preferences, '回复简洁；需要决策时先问我。')
      assert.equal(saved.version, initial.version + 1)
      draft = {
        ...saved,
        roles: [
          ...saved.roles,
          {
            id: ROLE,
            name: '评审角色',
            enabled: false,
            prompt: '负责评审，遇到范围不清楚的事项先问我。',
            executionDeviceId: saved.executionDeviceId,
            version: 0,
            collaboration: {
              enabled: false,
              allProjects: false,
              projects: [],
              excludedProjects: [],
              tags: [],
            },
          },
        ],
      }
      await selectE2EModel(control, undefined, undefined, CHAT)
      await control.command('fill', INPUT, { value: PROPOSE })
      await control.command('press', INPUT, { key: 'Enter' })
      await openStandInDetails(control)
      await control.command('waitFor', '[data-testid="stand-in-proposal-open"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
        text: '收到，我来拟定评审角色。',
      })
      assert.ok(
        !(await control.command('getText', CHAT)).includes(
          'IDENTITY_INTERNAL_PROGRESS_MUST_STAY_HIDDEN'
        )
      )
      assert.equal(
        (
          await requestExecutor(
            control,
            'runtime.stand_in.personal.get',
            { userId: USER },
            uiTimeoutMs
          )
        ).roles.length,
        saved.roles.length
      )
      assert.equal(sentProposal, true, 'The real managed MCP must create the draft')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-proposal-open"]')
      await control.command('waitFor', '[data-testid="stand-in-proposal"]')
      await captureScreenshot(control, '03-proposal-awaiting-confirmation.png', ROOT)
      await control.command('click', '[data-testid="stand-in-proposal-accept"]')
      await control.command('waitFor', `[data-testid="stand-in-overview-role-${ROLE}"]`)
      await captureScreenshot(control, '04-confirmed-role.png', ROOT)
      await control.command('fill', INPUT, { value: FOLLOWUP })
      await control.command('press', INPUT, { key: 'Enter' })
      await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
        text: '已记住这次补充',
        timeoutMs: modelResponseTimeoutMs,
      })
      await captureScreenshot(control, '05-persistent-follow-up.png', ROOT)
      await control.command('click', `[data-testid="stand-in-overview-role-${ROLE}"]`)
      await openStandInActivity(control)
      await control.command('waitFor', '[data-testid="stand-in-activity"]')
      await captureScreenshot(control, '06-role-work-list.png', ROOT)
      await control.command('click', '[data-testid="stand-in-work-dialog-close"]')
      await control.command('waitFor', CHAT)
      await captureScreenshot(control, '07-role-conversation.png', ROOT)
      await openStandInSettings(control)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-connections-open"]')
      await openConnectionTypePicker(control)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-add-dingtalk-connection"]')
      if (
        Number(await control.command('getElementCount', '[data-testid="stand-in-dingtalk-add"]')) >
        0
      )
        await control.command('click', '[data-testid="stand-in-dingtalk-add"]')
      await control.command('click', '[data-testid="stand-in-dingtalk-scope-selected"]')
      await control.command('waitFor', '[data-testid="stand-in-dingtalk-query"]')
      await captureScreenshot(control, '08-explicit-source-selection.png', ROOT)
      await control.command('click', '[data-testid="stand-in-cancel"]')
      await control.command('click', '[data-testid="stand-in-primary-open"]')
      await control.command('waitFor', `${CHAT} [data-testid="message-assistant"]`, {
        text: '已记住这次补充',
      })
      await captureScreenshot(control, '09-restored-primary-conversation.png', ROOT)
      const identity = await requestExecutor(
        control,
        'runtime.tasks.get',
        { taskId: `stand-in-chat-${USER}-primary` },
        uiTimeoutMs
      )
      assert.equal(identity.task.taskId, `stand-in-chat-${USER}-primary`)
      assert.equal(identity.task.runtimeHandle.modelSelection.options.codexProviderId, 'wework-e2e')
      assert.ok(requests.includes('followup'))
      const selection = identity.task.runtimeHandle.modelSelection
      const clientId = 'identity-create-race-message'
      const attachmentPath = join(workspacePath, 'README.md')
      await requestExecutor(
        control,
        'runtime.stand_in.conversation',
        {
          userId: USER,
          message: `${FOLLOWUP} creation race`,
          options: {
            modelId: selection.modelName,
            modelType: selection.modelType,
            modelOptions: { ...selection.options, reasoning_effort: 'low' },
            clientUserMessageId: clientId,
            attachments: [
              {
                id: -1,
                filename: 'README.md',
                local_path: attachmentPath,
                file_size: (await stat(attachmentPath)).size,
                mime_type: 'text/markdown',
                status: 'ready',
                file_extension: 'md',
                created_at: new Date().toISOString(),
              },
            ],
          },
        },
        uiTimeoutMs
      )
      const continued = await requestExecutor(
        control,
        'runtime.tasks.get',
        {
          taskId: identity.task.taskId,
        },
        uiTimeoutMs
      )
      assert.equal(
        continued.task.runtimeHandle.modelSelection.options.codexProviderId,
        'wework-e2e'
      )
      assert.equal(continued.task.runtimeHandle.modelSelection.options.reasoning_effort, 'low')
      await control.command('waitFor', `${CHAT} [data-testid="user-message-content"]`, {
        text: `${FOLLOWUP} creation race`,
      })
      const transcript = await requestExecutor(
        control,
        'runtime.tasks.transcript',
        {
          taskId: identity.task.taskId,
          limit: 20,
        },
        uiTimeoutMs
      )
      const presentation = transcript.messages.find(
        message => message.clientUserMessageId === clientId
      )
      assert.ok(presentation, 'The existing-link create path must preserve message identity')
      assert.equal(presentation.attachments[0].filename, 'README.md')
      await proposalRegression.verify(control)
    },
    diagnostics() {
      return { sentProposal, requests }
    },
  }
}
