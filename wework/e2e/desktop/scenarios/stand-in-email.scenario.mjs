import {
  openStandInActivity,
  openStandInDetails,
  openStandInSettings,
} from '../modules/stand-in-profile-navigation.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { prepareHarnessRuntimeRoots } from '../modules/desktop-build-flows.mjs'
import { startRealMailServer } from '../modules/real-mail-server.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { openConnectionTypePicker } from '../modules/stand-in-flows.mjs'
import { createDailyBriefStory } from '../modules/stand-in-daily-brief-story.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PROVIDER = '@wegent/dsh-connection-runtime/email'
const MARKER = 'EMAIL_INTAKE_USER_STORY'
const USER = 9001
const CARD = '[data-testid="request-user-input-card"]'

export function createDesktopScenario({
  resultDir,
  workspacePath,
  executorHome,
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let mail
  let round = 0
  let coordinatorRound = 0
  let originalSettings
  let messageId
  const dailyStory = createDailyBriefStory({
    executorHome,
    captureScreenshot,
    uiTimeoutMs,
    modelResponseTimeoutMs,
  })
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const backend = async (control, method, params = {}) =>
    JSON.parse(
      await control.command('invokeDshPluginBackend', 'body', {
        value: JSON.stringify({ plugin: 'wework-connection-runtime', method, params }),
      })
    )
  return {
    async prepareApp({ appEnvironment, appBinary }) {
      const sharedRoot = appEnvironment.WEWORK_HARNESS_RUNTIME_ROOT
      const root = sharedRoot ?? (await prepareHarnessRuntimeRoots(appBinary)).harnessRuntimeRoot
      const catalogPath = sharedRoot
        ? join(root, 'runtimes.json')
        : join(
            dirname(appBinary),
            ...(process.platform === 'darwin' ? ['..', 'Resources'] : ['resources']),
            'harness-runtime',
            'runtimes.json'
          )
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
      if (!sharedRoot) {
        // Reuse the same immutable extraction for the mail clients and Electron.
        await writeFile(join(root, 'runtimes.json'), JSON.stringify(catalog))
        appEnvironment.WEWORK_HARNESS_RUNTIME_ROOT = root
      }
      const core = catalog.runtimes.find(
        runtime => runtime.role === 'core' || runtime.roles?.includes('core')
      )
      assert.ok(core)
      mail = await startRealMailServer(
        join(resultDir, 'mail-server'),
        join(root, core.sourceFingerprint)
      )
      appEnvironment.NODE_EXTRA_CA_CERTS = mail.certificate
      // Exercise the real server's 24-hour APPEND parsing regardless of CI wall time.
      for (const hour of ['00', '12']) {
        await mail.append(
          `Historical ${hour}:33 mail must stay out of stand-in work`,
          'HISTORICAL_MAIL',
          `<history-${hour}@example.com>`,
          new Date(`2020-01-01T${hour}:33:30.000Z`)
        )
      }
      await mail.deliver(
        'Historical mail must stay out of stand-in work',
        'HISTORICAL_MAIL',
        '<history@example.com>'
      )
    },
    async handleHttp(req, response, url) {
      if (await dailyStory.handleHttp(req, response, url)) return true
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const resultEvents = delegatedTaskResultEvents(body)
      if (resultEvents) {
        const id = `email-result-${Date.now()}`
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(id), ...resultEvents, responseCompleted(id)]))
        return true
      }
      const input = JSON.stringify(body.input ?? [])
      if (input.includes('Review this silent intake batch')) {
        const readId = `email-intake-${coordinatorRound}`
        const actionId = `email-arrange-${coordinatorRound}`
        let events
        if (requestContainsToolOutput(body, actionId)) {
          assert.equal(JSON.parse(readMcpToolOutput(body, actionId)).status, 'pending')
          events = [assistantMessage('已安排邮件工作。')]
          coordinatorRound++
        } else if (requestContainsToolOutput(body, readId)) {
          const snapshot = JSON.parse(readMcpToolOutput(body, readId)).snapshot
          const event = snapshot.events.find(item => item.kind === 'connection')
          const toolName = event ? 'create_work' : 'ignore_events'
          events = mcpToolRequestEvents(body, {
            toolName,
            directToolName: `mcp__wework_stand_in__${toolName}`,
            argumentsValue: event
              ? { eventIds: [event.id], roleId: event.roleIds[0], title: '邮箱接入验证' }
              : { eventIds: snapshot.events.map(item => item.id), reason: '邮件处理状态已记录' },
            searchCallId: `email-arrange-search-${coordinatorRound}`,
            toolCallId: actionId,
          }).events
        } else
          events = mcpToolRequestEvents(body, {
            toolName: 'read_intake',
            directToolName: 'mcp__wework_stand_in__read_intake',
            argumentsValue: {},
            searchCallId: `email-intake-search-${coordinatorRound}`,
            toolCallId: readId,
          }).events
        const id = `email-coordinator-${Date.now()}`
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
        return true
      }
      if (!input.includes(MARKER)) return false
      const readId = `email-read-${round}`
      const sendId = `email-send-${round}`
      let events
      if (requestContainsToolOutput(body, sendId)) {
        if (round === 1) assert.equal(JSON.parse(readMcpToolOutput(body, sendId)).status, 'sent')
        events = [assistantMessage(round === 0 ? '已取消发送，邮件未发出。' : '邮件已确认发送。')]
      } else if (requestContainsToolOutput(body, readId)) {
        const messages = JSON.parse(readMcpToolOutput(body, readId)).messages
        const source = messages.find(message => message.text.includes(MARKER))
        assert.ok(source, 'Read the real persisted IMAP event')
        messageId = source.id
        events = mcpToolRequestEvents(body, {
          toolName: 'send_email',
          directToolName: 'mcp__wework_stand_in__send_email',
          searchCallId: `email-send-search-${round}`,
          toolCallId: sendId,
          argumentsValue: {
            messageId,
            from: 'owner@example.com',
            to: 'sender@example.com',
            subject: 'Re: 邮箱接入验证',
            text: '收到邮件。\n\n这是经过本人确认的完整回复。',
            reply: true,
          },
        }).events
      } else
        events = mcpToolRequestEvents(body, {
          toolName: 'read_work',
          directToolName: 'mcp__wework_stand_in__read_work',
          argumentsValue: {},
          searchCallId: `email-read-search-${round}`,
          toolCallId: readId,
        }).events
      const id = `email-story-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      originalSettings = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const catalog = await rpc(control, 'runtime.runner.catalog', {})
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model)
      await control.command('seedLocalProject', 'body', {
        value: JSON.stringify({
          projectKey: 'email-story',
          name: '邮箱工作验证',
          path: workspacePath,
        }),
      })
      await rpc(control, 'runtime.stand_in.personal.save', {
        userId: USER,
        settings: {
          ...originalSettings,
          primary: {
            ...originalSettings.primary,
            enabled: true,
            prompt: originalSettings.primary?.prompt ?? '',
            preferences: originalSettings.primary?.preferences ?? '',
            model,
            workspace: {
              projectKey: 'email-story',
              workspacePath,
              executionMode: 'current_workspace',
            },
          },
        },
      })
      await ensureExperimentalFeaturesEnabled(control)
      for (const target of [
        'workspace-tab-select-fixed-board',
        'workspace-tab-select-fixed-task',
        'personal-stand-in-button',
        'stand-in-settings-open',
        'stand-in-primary-connections-open',
      ])
        if (target === 'stand-in-settings-open') await openStandInSettings(control)
        else await control.command('clickWhenEnabled', `[data-testid="${target}"]`)
      await openConnectionTypePicker(control)
      await control.command(
        'clickWhenEnabled',
        `[data-testid="stand-in-add-${PROVIDER}-connection"]`
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-email-add"]')
      await captureScreenshot(control, '01-mailbox-configuration.png')
      await control.command('fill', '[data-testid="stand-in-email-email"]', {
        value: mail.config.email,
      })
      await control.command('click', '[data-testid="stand-in-connections-back"]')
      await control.command('waitFor', '[data-testid="stand-in-email-discard"]')
      await control.command('click', '[data-testid="stand-in-email-discard-cancel-button"]')
      await control.command('click', '[data-testid="stand-in-connections-back"]')
      await control.command('waitFor', '[data-testid="stand-in-email-discard"]')
      await captureScreenshot(control, '01a-unsaved-mailbox-protected.png')
      await control.command('click', '[data-testid="stand-in-email-discard-cancel-button"]')
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-email-email"]'),
        mail.config.email
      )
      for (const [field, value] of Object.entries({
        username: mail.config.username,
        password: mail.config.password,
        'imap-host': mail.config.imap.host,
        'imap-port': String(mail.config.imap.port),
        'smtp-host': mail.config.smtp.host,
        'smtp-port': '1',
      }))
        await control.command('fill', `[data-testid="stand-in-email-${field}"]`, { value })
      await control.command('fill', '[data-testid="stand-in-email-password"]', {
        value: 'invalid-mail-password',
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-email-save"]')
      await control.command('waitFor', '[role="alert"]', {
        text: 'IMAP 登录失败',
        timeoutMs: modelResponseTimeoutMs,
      })
      await captureScreenshot(control, '01b-imap-login-failure-preserves-form.png')
      await control.command('fill', '[data-testid="stand-in-email-password"]', {
        value: mail.config.password,
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-email-save"]')
      await control.command('waitFor', '[role="alert"]', {
        text: 'SMTP',
        timeoutMs: modelResponseTimeoutMs,
      })
      await captureScreenshot(control, '02-smtp-error-preserves-form.png')
      await control.command('fill', '[data-testid="stand-in-email-smtp-port"]', {
        value: String(mail.config.smtp.port),
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-email-save"]')
      await control.command('waitFor', '[data-testid="stand-in-email-verified"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      const accounts = await backend(control, 'emailAccounts')
      assert.equal(accounts.length, 1)
      assert.equal(accounts[0].password, undefined)
      const accountId = accounts[0].id
      await control.command(
        'clickWhenEnabled',
        '[data-testid="stand-in-processing-settings-toggle"]'
      )
      await control.command('click', `[data-testid="stand-in-email-policy-${accountId}"]`)
      await captureScreenshot(control, '03-account-verified-connection-pending-save.png')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
      await control.command('waitFor', '[data-testid="stand-in-primary-save"]', { visible: false })
      const saved = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      assert.equal(saved.primary.connections[0].profile, accountId)
      assert.ok(!JSON.stringify(saved).includes(mail.config.password))
      mail.pauseImap()
      await openStandInDetails(control)
      await control.command('waitFor', '[data-testid="stand-in-status-open"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-status-open"]')
      await control.command('waitFor', '[role="alert"]', {
        text: '将自动重试',
        timeoutMs: modelResponseTimeoutMs,
      })
      const interrupted = await rpc(control, 'runtime.stand_in.work.list', { userId: USER })
      assert.equal(interrupted.sourceErrors[0].error.code, 'email_transport_failed')
      await captureScreenshot(control, '03a-incoming-connection-will-retry.png')
      await control.command('click', '[data-testid="stand-in-status-dialog-close"]')
      mail.resumeImap()
      await mail.deliver(
        '邮箱接入验证',
        `${MARKER}\n请拟定邮件回复，发送前让我确认。`,
        '<new-email@example.com>'
      )
      // The transport's real 30-second retry backoff precedes model processing.
      await until(
        () => rpc(control, 'runtime.stand_in.work.list', { userId: USER }),
        state => state.sourceErrors.length === 0,
        'Restored IMAP transport must complete its scheduled retry before processing new mail',
        30000 + modelResponseTimeoutMs
      )
      await openStandInActivity(control)
      await control.command('waitFor', '[data-testid^="stand-in-activity-task-"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      const works = await rpc(control, 'runtime.stand_in.work.list', { userId: USER })
      assert.deepEqual(works.sourceErrors, [])
      assert.equal(
        (await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })).version,
        saved.version,
        'Restored transport must resume intake without saving settings again'
      )
      assert.equal(works.items.length, 1, 'Historical mail must not create work')
      const work = works.items[0]
      await openStandInActivity(control)
      await control.command(
        'clickWhenEnabled',
        `[data-testid="stand-in-activity-task-${work.taskId}"]`
      )
      await control.command('waitFor', '[data-testid="stand-in-work-open-pending"]')
      await captureScreenshot(control, '04a-mail-work-needs-confirmation.png')
      await control.command('click', '[data-testid="stand-in-work-open-pending"]')
      await control.command('waitFor', '[data-testid="interaction-open-original"]')
      await control.command('click', '[data-testid="interaction-open-original"]')
      await control.command('waitFor', CARD, { timeoutMs: modelResponseTimeoutMs })
      const preview = await control.command('getText', CARD, { visible: true })
      await writeFile(join(resultDir, 'native-approval-preview.txt'), preview)
      await writeFile(
        join(resultDir, 'native-approval-metrics.json'),
        await control.command('getElementMetrics', CARD)
      )
      for (const value of [
        'owner@example.com',
        'sender@example.com',
        'Re: 邮箱接入验证',
        '这是经过本人确认的完整回复。',
      ])
        assert.ok(preview.includes(value), `Email confirmation must include ${value}`)
      assert.equal((await mail.received()).length, 0, 'No SMTP message before confirmation')
      await control.command('startElementMetricsSampling', CARD, { value: '500', visible: true })
      let sample
      const frameDeadline = Date.now() + uiTimeoutMs
      do {
        sample = JSON.parse(await control.command('getElementMetricsSample', CARD))
        assert.ok(Date.now() < frameDeadline, 'The visible approval must render animation frames')
        if (!sample.done) await new Promise(resolve => setTimeout(resolve, 30))
      } while (!sample.done)
      await writeFile(join(resultDir, 'native-approval-frames.json'), JSON.stringify(sample))
      await captureScreenshot(control, '04-complete-native-send-confirmation.png')
      const afterCapture = await control.command('getText', CARD, { visible: true })
      await writeFile(join(resultDir, 'native-approval-after-capture.txt'), afterCapture)
      assert.ok(
        afterCapture.includes('这是经过本人确认的完整回复。'),
        'The visible approval must retain the full email preview after rendering'
      )
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1000, height: 760 }),
      })
      await captureScreenshot(control, '04b-narrow-send-confirmation.png')
      await control.command('click', '[data-testid="request-user-input-option-__mcp_approval-1"]')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: '已取消发送',
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal((await mail.received()).length, 0, 'Cancellation must not send mail')
      await captureScreenshot(control, '05-send-cancelled.png')
      round = 1
      await control.command('fill', '[data-testid="chat-message-input"]', {
        value: '请重新拟定回复，发送前让我确认。',
      })
      await control.command('clickWhenEnabled', '[data-testid="send-message-button"]')
      await control.command('waitFor', CARD, { timeoutMs: modelResponseTimeoutMs })
      await control.command('click', '[data-testid="request-user-input-option-__mcp_approval-0"]')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: '邮件已确认发送',
        timeoutMs: modelResponseTimeoutMs,
      })
      const received = await mail.received()
      await writeFile(
        join(resultDir, 'mail-delivery.json'),
        JSON.stringify(
          received.map(item => ({ envelope: item.envelope, source: item.source.toString() })),
          null,
          2
        )
      )
      assert.equal(received.length, 1)
      assert.ok(received[0].source.toString().includes('In-Reply-To: <new-email@example.com>'))
      assert.ok(received[0].source.toString().includes('References: <new-email@example.com>'))
      await captureScreenshot(control, '06-confirmed-mail-delivered.png')
      await captureScreenshot(control, '07-narrow-work-conversation.png')
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('waitFor', '[data-testid="appearance-mode-dark"]')
      await control.command('click', '[data-testid="appearance-mode-dark"]')
      await control.command('waitFor', 'html[data-theme="dark"]')
      await control.command('click', '[data-testid="settings-back-button"]')
      for (const target of [
        'workspace-tab-select-fixed-task',
        'personal-stand-in-button',
        'stand-in-settings-open',
        'stand-in-primary-connections-open',
        `stand-in-add-${PROVIDER}-connection`,
      ])
        if (target === 'stand-in-settings-open') await openStandInSettings(control)
        else await control.command('clickWhenEnabled', `[data-testid="${target}"]`)
      await control.command('waitFor', '[data-testid="stand-in-email-add"]', { visible: true })
      await captureScreenshot(control, '08-narrow-dark-mailbox-connections.png')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-email-add"]')
      await control.command('waitFor', '[data-testid="stand-in-email-form"]')
      await captureScreenshot(control, '09-narrow-dark-mailbox-form.png')
      await control.command('scrollIntoView', '[data-testid="stand-in-email-save"]')
      await captureScreenshot(control, '10-narrow-dark-mailbox-form-actions.png')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-email-add"]')
      // Reusing a paused role from a project must establish a fresh server UID boundary.
      const project = await rpc(control, 'projects.create', { name: '邮箱角色复用验证' })
      let current = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const role = {
        ...current.roles[0],
        id: 'default',
        name: '邮箱项目角色',
        enabled: false,
        version: 0,
        connections: current.primary.connections,
        model,
      }
      current = await rpc(control, 'runtime.stand_in.personal.save', {
        userId: USER,
        settings: {
          ...current,
          primary: { ...current.primary, enabled: false },
          roles: current.roles.map(item =>
            item.id === 'default' ? { ...role, version: item.version } : item
          ),
        },
      })
      await mail.deliver(
        '停用期间收到的邮件',
        'PAUSED_MAIL_MUST_NOT_REPLAY',
        '<paused@example.com>'
      )
      const paused = { ...current.roles.find(item => item.id === role.id), enabled: true }
      delete paused.connections
      delete paused.id
      const reused = await rpc(control, 'runtime.stand_in.save', {
        userId: USER,
        projectId: project.id,
        projectStore: 'local',
        settings: paused,
      })
      const inbox = await mail.received('owner')
      assert.equal(reused.connections[0].profile, accountId)
      assert.equal(
        reused.connections[0].boundary.sequence,
        Math.max(...inbox.map(item => item.uid))
      )
      assert.ok(reused.connections[0].enabledAfter)
      await mail.deliver('待采集的新邮件', 'PROJECT_PENDING_NEW_MAIL', '<pending@example.com>')
      const ordinaryEdit = { ...reused, prompt: '更新项目处理要求' }
      delete ordinaryEdit.id
      delete ordinaryEdit.connections
      const edited = await rpc(control, 'runtime.stand_in.save', {
        userId: USER,
        projectId: project.id,
        projectStore: 'local',
        settings: ordinaryEdit,
      })
      assert.deepEqual(
        edited.connections[0].boundary,
        reused.connections[0].boundary,
        'Ordinary project edits with a default role ID must preserve the pending-mail boundary'
      )
      await dailyStory.verify(
        control,
        (method, params) => rpc(control, method, params),
        mail,
        model
      )
    },
    async cleanup() {
      await mail?.stop()
    },
    diagnostics() {
      return { round, sourceMessageId: messageId }
    },
  }
}
