import assert from 'node:assert/strict'
import { createDesktopScenario as createProfile } from './stand-in-profile.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { openConnectionTypePicker } from '../modules/stand-in-flows.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { waitForElementWidth } from '../modules/layout-metrics.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001

/** Add review coverage to the existing CI checkpoint without another app build or startup. */
export function createDesktopScenario(options) {
  const original = createProfile(options)
  let readEvidence = false
  return {
    ...original,
    verifiesStandInOnboarding: true,
    async handleHttp(req, response, url) {
      if (req.method === 'POST' && ['/responses', '/v1/responses'].includes(url.pathname)) {
        const body = await readRequestBody(req)
        if (
          !isReplyPredictionRequest(body) &&
          JSON.stringify(body.input ?? []).includes('Use read_review_history')
        ) {
          let events
          if (requestContainsToolOutput(body, 'review-read')) {
            const page = JSON.parse(readMcpToolOutput(body, 'review-read'))
            assert.equal(page.success, true)
            assert.ok(page.messages.length > 0, 'The real transcript must contain review evidence')
            readEvidence = true
            events = [assistantMessage('WEEKLY_REVIEW_VERIFIED：已根据工作对话给出改进建议。')]
          } else if (requestContainsToolOutput(body, 'review-list')) {
            const page = JSON.parse(readMcpToolOutput(body, 'review-list'))
            assert.ok(page.items.some(item => item.taskId === `stand-in-chat-${USER}-primary`))
            events = mcpToolRequestEvents(body, {
              toolName: 'read_review_history',
              directToolName: 'mcp__wework_stand_in__read_review_history',
              argumentsValue: { taskId: `stand-in-chat-${USER}-primary` },
              searchCallId: 'review-read-search',
              toolCallId: 'review-read',
            }).events
          } else {
            events = mcpToolRequestEvents(body, {
              toolName: 'read_review_history',
              directToolName: 'mcp__wework_stand_in__read_review_history',
              argumentsValue: {},
              searchCallId: 'review-list-search',
              toolCallId: 'review-list',
            }).events
          }
          const id = `review-${Date.now()}`
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
          return true
        }
      }
      return original.handleHttp(req, response, url)
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('waitFor', '[data-testid="stand-in-onboarding-review"]:checked')
      assert.equal(
        await control.command('getValue', '[data-testid="stand-in-onboarding-time"]'),
        '09:00'
      )
      await options.captureScreenshot(control, 'review-01-onboarding-desktop.png')
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 760, height: 850 }),
      })
      await waitForElementWidth(
        control,
        '[data-testid="stand-in-onboarding"]',
        width => width <= 760,
        'narrow review onboarding'
      )
      const [narrow] = JSON.parse(
        await control.command('getElementMetrics', '[data-testid="stand-in-onboarding"]')
      )
      assert.ok(
        narrow.scrollWidth <= narrow.clientWidth,
        'Onboarding must not overflow horizontally'
      )
      await options.captureScreenshot(control, 'review-02-onboarding-narrow.png')
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1280, height: 720 }),
      })
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('clickWhenEnabled', '[data-testid="appearance-mode-dark"]')
      await control.command('waitFor', 'html[data-theme="dark"]')
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', '[data-testid="stand-in-onboarding-review"]:checked')
      await options.captureScreenshot(control, 'review-03-onboarding-dark.png')
      await control.command('click', '[data-testid="stand-in-onboarding-review"]')
      await control.command('waitFor', '[data-testid="stand-in-onboarding-time"]:disabled')
      await options.captureScreenshot(control, 'review-04-review-unchecked.png')
      await control.command('nativePress', '[data-testid="stand-in-onboarding-review"]', {
        key: 'Space',
      })
      await control.command('waitFor', '[data-testid="stand-in-onboarding-review"]:checked')
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('clickWhenEnabled', '[data-testid="appearance-mode-light"]')
      await control.command('waitFor', 'html[data-theme="light"]')
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', '[data-testid="stand-in-onboarding-review"]:checked')
      await control.command('click', '[data-testid="stand-in-onboarding-close"]')
      assert.equal(
        (await rpc('runtime.stand_in.onboarding.get', { userId: USER })).state.completed,
        false
      )
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('fill', '[data-testid="stand-in-onboarding-time"]', { value: '10:30' })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-complete"]')
      await control.command('waitFor', '[data-testid="stand-in-settings-open"]')
      const review = (await rpc('runtime.automations.list', {})).items.find(
        item => item.taskRequest?.standInCalendar?.template === 'weekly_review'
      )
      assert.ok(review)
      assert.equal(review.enabled, true)
      assert.equal(review.timezone, 'Asia/Shanghai')
      assert.equal(review.schedule.expression, '30 10 * * 1')
      await rpc('runtime.automations.toggle', { automationId: review.id, enabled: false })
      await rpc('runtime.stand_in.onboarding.complete', { userId: USER, weeklyReview: true })
      assert.equal(
        (await rpc('runtime.automations.get', { automationId: review.id })).automation.enabled,
        false
      )
      await rpc('runtime.automations.delete', { automationId: review.id })
      await rpc('runtime.stand_in.onboarding.complete', { userId: USER, weeklyReview: true })
      assert.ok(
        !(await rpc('runtime.automations.list', {})).items.some(item => item.id === review.id)
      )

      // The original checkpoint retains every assertion and establishes its own model/calendar prerequisites.
      await original.verify(control)
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1280, height: 720 }),
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
      await control.command('click', '[data-testid="stand-in-primary-connections-open"]')
      await openConnectionTypePicker(control)
      await control.command('click', '[data-testid="stand-in-time-connections"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-weekly-review-template"]')
      await control.command('waitFor', '[data-testid="automation-name-input"]')
      assert.equal(
        await control.command('getValue', '[data-testid="automation-name-input"]'),
        '每周工作复盘'
      )
      await options.captureScreenshot(control, 'review-05-calendar-template.png')
      await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]')
      await control.command('waitFor', '[data-testid="automation-save-button"]', { visible: false })
      const recreated = (await rpc('runtime.automations.list', {})).items.find(
        item => item.taskRequest?.standInCalendar?.template === 'weekly_review'
      )
      assert.ok(recreated)
      await control.command('click', `[data-testid="automation-open-${recreated.id}"]`)
      await control.command('click', `[data-testid="automation-detail-actions-${recreated.id}"]`)
      await control.command('click', '[data-testid="automation-run-now-button"]')
      await control.command('waitFor', '[data-testid="automation-run-history"]', {
        text: '已完成',
        timeoutMs: options.modelResponseTimeoutMs,
      })
      assert.equal(
        readEvidence,
        true,
        'The real scheduled execution must read authorized task history'
      )
      const runs = (await rpc('runtime.automation_runs.list', { automationId: recreated.id })).items
      const completed = runs.find(run => run.status === 'succeeded')
      assert.ok(completed?.taskId)
      await control.command('click', `[data-testid="automation-run-open-${completed.id}"]`)
      await control.command('waitFor', 'body', { text: 'WEEKLY_REVIEW_VERIFIED' })
      await options.captureScreenshot(control, 'review-06-report-conversation.png')
      await rpc('runtime.automations.delete', { automationId: recreated.id })
    },
  }
}
