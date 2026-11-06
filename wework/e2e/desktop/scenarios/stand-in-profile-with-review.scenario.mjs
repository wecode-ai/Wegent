import assert from 'node:assert/strict'
import { createDesktopScenario as createProfile } from './stand-in-profile.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesDisabled } from '../modules/preferences-automation-flows.mjs'
import { openConnectionTypePicker } from '../modules/stand-in-flows.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { inCollaborationSidebar } from '../modules/workspace-flows.mjs'
import { waitForElementWidth } from '../modules/layout-metrics.mjs'
import { createWeeklyUserStory } from '../modules/stand-in-weekly-user-story.mjs'
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
const GUIDE = '[data-testid="stand-in-onboarding"]'

/** Checks first-use connection setup separately from the existing help examples. */
async function verifyGuideExamples(control, completed = false) {
  if (!completed) {
    await control.command('waitFor', '[data-testid="stand-in-connection-type-picker"]')
    await control.command('waitFor', '[data-testid="stand-in-onboarding-continue"]:enabled')
    assert.equal(
      await control.command(
        'getElementCount',
        `${GUIDE} button[data-testid^="stand-in-onboarding-example-"]`
      ),
      '0'
    )
    assert.equal(
      await control.command('getElementCount', '[data-testid="stand-in-onboarding-complete"]'),
      '0'
    )
    return
  }
  for (const example of [
    'daily_brief',
    'meeting_prep',
    'project_followup',
    'dingtalk_reply',
    'weekly_review',
  ]) {
    await control.command('waitFor', `button[data-testid="stand-in-onboarding-example-${example}"]`)
  }
  assert.equal(
    await control.command(
      'getElementCount',
      `${GUIDE} button[data-testid^="stand-in-onboarding-example-"]`
    ),
    '5'
  )
  for (const selector of [
    `${GUIDE} input[type="checkbox"]`,
    `${GUIDE} input[type="time"]`,
    '[data-testid="stand-in-onboarding-review"]',
    '[data-testid="stand-in-onboarding-time"]',
  ]) {
    assert.equal(await control.command('getElementCount', selector), '0')
  }
  assert.equal(
    await control.command('getElementCount', '[data-testid="stand-in-onboarding-complete"]'),
    completed ? '0' : '1',
    'Only first-run onboarding has a completion action; reopened examples do not repeat setup'
  )
}

async function openCalendarReviewTemplate(control) {
  await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
  await control.command('click', '[data-testid="stand-in-primary-connections-open"]')
  await openConnectionTypePicker(control)
  await control.command('click', '[data-testid="stand-in-time-connections"]')
  await control.command('clickWhenEnabled', '[data-testid="stand-in-weekly-review-template"]')
  await control.command('waitFor', '[data-testid="automation-name-input"]')
}

/** Add review coverage to the existing CI checkpoint without another app build or startup. */
export function createDesktopScenario(options) {
  const original = createProfile(options)
  const weeklyStory = createWeeklyUserStory(options)
  let readEvidence = false
  let reviewCall
  let reviewSequence = 0
  const reviewTaskIds = new Set()
  const pendingReviewReads = []
  const requestReviewRead = (body, name, args) => {
    reviewCall = { name, args, id: `review-call-${++reviewSequence}` }
    return emitReviewRead(body)
  }
  const emitReviewRead = body =>
    mcpToolRequestEvents(body, {
      toolName: reviewCall.name,
      directToolName: `mcp__wework_stand_in__${reviewCall.name}`,
      argumentsValue: reviewCall.args,
      searchCallId: `${reviewCall.id}-search`,
      toolCallId: reviewCall.id,
    }).events
  return {
    ...original,
    verifiesStandInOnboarding: true,
    async handleHttp(req, response, url) {
      if (await weeklyStory.handleHttp(req, response, url)) return true
      if (req.method === 'POST' && ['/responses', '/v1/responses'].includes(url.pathname)) {
        const body = await readRequestBody(req)
        if (
          !isReplyPredictionRequest(body) &&
          JSON.stringify(body.input ?? []).includes('The host fixes the read window')
        ) {
          let events
          if (!reviewCall) {
            events = requestReviewRead(body, 'list_tasks', {})
          } else if (!requestContainsToolOutput(body, reviewCall.id)) {
            events = emitReviewRead(body)
          } else {
            const page = JSON.parse(readMcpToolOutput(body, reviewCall.id))
            if (reviewCall.name === 'list_tasks') {
              for (const item of page.items) reviewTaskIds.add(item.taskId)
              if (page.hasMore) {
                assert.equal(typeof page.nextCursor, 'string')
                events = requestReviewRead(body, 'list_tasks', { cursor: page.nextCursor })
              } else {
                assert.ok(reviewTaskIds.has(`stand-in-chat-${USER}-primary`))
                events = requestReviewRead(body, 'read_task', {
                  taskId: `stand-in-chat-${USER}-primary`,
                })
              }
            } else {
              assert.equal(page.success, true)
              if (Array.isArray(page.messages)) {
                readEvidence ||= page.messages.length > 0
                for (const message of page.messages) {
                  if (message.contentComplete === false) {
                    assert.equal(typeof message.messageContentCursor, 'string')
                    pendingReviewReads.push({ messageContentCursor: message.messageContentCursor })
                  }
                }
                if (page.hasMoreBefore) {
                  assert.equal(typeof page.beforeCursor, 'string')
                  pendingReviewReads.push({ beforeCursor: page.beforeCursor })
                }
              } else {
                assert.equal(typeof page.content, 'string')
                if (page.contentComplete === false) {
                  assert.equal(typeof page.messageContentCursor, 'string')
                  pendingReviewReads.unshift({ messageContentCursor: page.messageContentCursor })
                }
              }
              if (pendingReviewReads.length) {
                events = requestReviewRead(body, 'read_task', {
                  taskId: `stand-in-chat-${USER}-primary`,
                  ...pendingReviewReads.shift(),
                })
              } else {
                assert.ok(readEvidence, 'The real transcript must contain review evidence')
                events = [assistantMessage('WEEKLY_REVIEW_VERIFIED：已根据工作对话给出改进建议。')]
              }
            }
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
      const initialScheduleIds = (await rpc('runtime.automations.list', {})).items
        .map(item => item.id)
        .sort()
      await ensureExperimentalFeaturesDisabled(control)
      await control.command('waitFor', '[data-testid="personal-stand-in-beta"]', { text: 'Beta' })
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await verifyGuideExamples(control)
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
      await verifyGuideExamples(control)
      await options.captureScreenshot(control, 'review-03-onboarding-dark.png')
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('clickWhenEnabled', '[data-testid="appearance-mode-light"]')
      await control.command('waitFor', 'html[data-theme="light"]')
      await control.command('navigate', 'body', { value: '/stand-in' })
      await verifyGuideExamples(control)
      await control.command('click', '[data-testid="stand-in-onboarding-close"]')
      await control.command('waitFor', GUIDE, { visible: false })
      assert.equal(
        (await rpc('runtime.stand_in.onboarding.get', { userId: USER })).state.completed,
        false
      )
      assert.deepEqual(
        (await rpc('runtime.automations.list', {})).items.map(item => item.id).sort(),
        initialScheduleIds,
        'Closing the introduction must not create any arrangement'
      )
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await verifyGuideExamples(control)
      const beforeSetup = await rpc('runtime.stand_in.personal.get', { userId: USER })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-continue"]')
      await control.command('waitFor', '[data-testid="stand-in-onboarding-summary"]')
      await control.command('click', '[data-testid="stand-in-onboarding-back"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-add-projects-connection"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-source-collaboration"]')
      await control.command('click', '[data-testid="stand-in-all-projects"]')
      assert.deepEqual(
        await rpc('runtime.stand_in.personal.get', { userId: USER }),
        beforeSetup,
        'Selecting a connection must remain a draft until final confirmation'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-continue"]')
      await control.command('waitFor', '[data-testid="stand-in-onboarding-summary"]', {
        text: '所有',
      })
      await control.command('click', '[data-testid="stand-in-onboarding-back"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-add-projects-connection"]')
      await control.command('waitFor', '[data-testid="stand-in-all-projects"]:checked')
      await control.command('click', '[data-testid="stand-in-source-collaboration"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-continue"]')
      await control.command('waitFor', '[data-testid="stand-in-onboarding-summary"]', {
        text: '还没有连接应用',
      })
      const concurrentSettings = await rpc('runtime.stand_in.personal.save', {
        userId: USER,
        settings: {
          ...beforeSetup,
          primary: {
            prompt: '',
            ...beforeSetup.primary,
            enabled: false,
            preferences: 'E2E concurrent settings',
          },
        },
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-complete"]')
      await control.command('waitFor', '[data-testid="stand-in-onboarding-setup"] [role="alert"]')
      assert.equal(
        (await rpc('runtime.stand_in.onboarding.get', { userId: USER })).state.completed,
        false,
        'A version conflict must not complete setup or overwrite concurrent settings'
      )
      await control.command(
        'clickWhenEnabled',
        '[data-testid="stand-in-onboarding-settings-retry"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-discard"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-continue"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-complete"]')
      await control.command('waitFor', GUIDE, { visible: false })
      await control.command('waitFor', '[data-testid="stand-in-settings-open"]')
      const afterSetup = await rpc('runtime.stand_in.personal.get', { userId: USER })
      assert.equal(
        afterSetup.primary.enabled,
        true,
        'No connections must still allow enabling the stand-in'
      )
      assert.equal(afterSetup.primary.preferences, 'E2E concurrent settings')
      assert.equal(afterSetup.primary.collaboration.enabled, false)
      assert.equal(afterSetup.primary.connections?.length ?? 0, 0)
      assert.deepEqual(
        afterSetup.roles.map(role => ({ ...role, version: 0 })),
        concurrentSettings.roles.map(role => ({ ...role, version: 0 })),
        'Onboarding must preserve existing scenario roles'
      )
      assert.equal(
        (await rpc('runtime.stand_in.onboarding.get', { userId: USER })).state.completed,
        true
      )
      assert.deepEqual(
        (await rpc('runtime.automations.list', {})).items.map(item => item.id).sort(),
        initialScheduleIds,
        'Completing the guide must not create any arrangement'
      )
      // Connecting later reuses the same settings UI without repeating setup.
      await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-connections-open"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-add-projects-connection"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-source-collaboration"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
      await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
        visible: false,
      })
      const connectedLater = await rpc('runtime.stand_in.personal.get', { userId: USER })
      assert.equal(connectedLater.primary.enabled, true)
      assert.equal(connectedLater.primary.collaboration.enabled, true)
      assert.equal(connectedLater.primary.collaboration.policy.immediate, false)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-guide-open"]')
      await verifyGuideExamples(control, true)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-onboarding-close"]')
      await control.command('waitFor', GUIDE, { visible: false })
      assert.equal(
        (await rpc('runtime.stand_in.onboarding.get', { userId: USER })).state.completed,
        true,
        'Closing usage examples must preserve completed onboarding'
      )
      assert.deepEqual(
        (await rpc('runtime.automations.list', {})).items.map(item => item.id).sort(),
        initialScheduleIds,
        'Closing usage examples must not create any arrangement'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-guide-open"]')
      await verifyGuideExamples(control, true)
      await control.command(
        'nativePress',
        '[data-testid="stand-in-onboarding-example-weekly_review"]',
        {
          key: 'Enter',
        }
      )
      await control.command('waitFor', GUIDE, { visible: false })
      await control.command(
        'waitFor',
        '[data-testid="stand-in-conversation"] [data-testid="chat-message-input"]',
        {
          text: '每周回顾本设备',
        }
      )
      assert.deepEqual(
        (await rpc('runtime.automations.list', {})).items.map(item => item.id).sort(),
        initialScheduleIds,
        'Choosing a review example must fill a draft without scheduling it'
      )
      await options.captureScreenshot(control, 'review-04-review-example-draft.png')
      await openCalendarReviewTemplate(control)
      await control.command('click', '[data-testid="automation-cron-time"]')
      await control.command('scrollIntoView', '[data-testid="automation-cron-time-option-10:30"]')
      await control.command('clickWhenEnabled', '[data-testid="automation-cron-time-option-10:30"]')
      await control.command('waitFor', '[data-testid="automation-cron-time"]', { text: '10:30' })
      await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]')
      await control.command('waitFor', '[data-testid="automation-save-button"]', { visible: false })
      const review = (await rpc('runtime.automations.list', {})).items.find(
        item => item.taskRequest?.standInCalendar?.template === 'weekly_review'
      )
      assert.ok(review)
      assert.equal(review.enabled, true)
      assert.equal(review.timezone, 'Asia/Shanghai')
      assert.equal(review.schedule.expression, '30 10 * * 1')
      await control.command('click', '[data-testid="stand-in-primary-profile-close"]')
      await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
        visible: false,
      })
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
      assert.ok(
        !(await rpc('runtime.automations.list', {})).items.some(
          item => item.taskRequest?.standInCalendar?.template === 'weekly_review'
        ),
        'Completing the guide again must not recreate a deleted review'
      )

      // The original checkpoint retains every assertion and establishes its own model/calendar prerequisites.
      await original.verify(control)
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1280, height: 720 }),
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await openCalendarReviewTemplate(control)
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
      await weeklyStory.verify(control, openCalendarReviewTemplate)
      await ensureExperimentalFeaturesDisabled(control)
      await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]')
      const projects = await rpc('projects.list', {})
      const project = projects.find(row => row.name === `负责人上下文验证-${process.pid}`)
      assert.ok(project, 'Reuse the coordinator project from the original profile story')
      await control.command(
        'clickWhenEnabled',
        inCollaborationSidebar(`[data-testid="collaboration-workspace-project-${project.id}"]`)
      )
      await control.command('waitFor', '[data-testid="stand-in-project-beta"]', { text: 'Beta' })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-open"]')
      await control.command('waitFor', '[data-testid="stand-in-dialog"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-close"]')
      await control.command('waitFor', '[data-testid="stand-in-dialog"]', { visible: false })
    },
  }
}
