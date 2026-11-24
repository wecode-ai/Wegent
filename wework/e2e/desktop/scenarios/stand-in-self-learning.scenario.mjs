import assert from 'node:assert/strict'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectWorkbenchTheme } from '../modules/appearance-theme.mjs'
import { pathExists, until } from '../modules/plugin-regression-fixture.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createSse,
  handleModelMaintenanceRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { createStandInDingTalkFixture } from '../modules/stand-in-dingtalk-fixture.mjs'
import {
  openStandInDetails,
  openStandInMemory,
  openStandInSettings,
} from '../modules/stand-in-profile-navigation.mjs'
import {
  createTrainingModel,
  DEMONSTRATIONS,
  ORIGINAL,
  REVISED,
} from '../modules/stand-in-self-learning-model.mjs'

const USER = 9001
const ROLE = 'triage-assistant'
const PROVIDER = '@wegent/dsh-connection-dingtalk/dingtalk'
const testId = name => `[data-testid="${name}"]`

async function verifyLearningReport(control, capture, stage, expected, options = {}) {
  if (options.refresh) {
    await control.command('clickWhenEnabled', testId('stand-in-learning-report-refresh'))
  } else {
    await openStandInSettings(control)
    await control.command('clickWhenEnabled', testId('stand-in-ghost-revision-open'))
  }
  await control.command('waitFor', testId('stand-in-learning-report'), { text: expected.status })
  await control.command('waitFor', testId('stand-in-learning-identity'), { text: ROLE })
  for (const [name, value] of Object.entries(expected.metrics)) {
    await control.command('waitFor', testId('stand-in-learning-' + name), { text: value })
    const actual = await control.command('getText', testId('stand-in-learning-' + name))
    assert.equal(actual.trim(), value)
  }
  for (const [axis, text] of Object.entries(expected.dimensions ?? {})) {
    await control.command('waitFor', testId('stand-in-learning-dimension-' + axis), { text })
  }
  await capture(control, `learning-report-${stage}.png`)
  if (options.keepOpen) return
  await control.command('clickWhenEnabled', testId('stand-in-close'))
  await control.command('waitFor', testId('stand-in-profile-panel'), { visible: false })
}

function source(name) {
  return {
    id: 'training-' + name,
    name,
    kind: 'group',
    collectionKey: 'all-messages',
    profile: 'connection-test-account',
    providerId: PROVIDER,
    policy: { automatic: false, askBeforeAct: true, immediate: false },
  }
}

async function publishHistory(root, populated) {
  const at = Date.now()
  for (const [suffix, question, answer] of DEMONSTRATIONS) {
    const group = source(suffix).id
    const message = (who, content, time) => ({
      openMessageId: group + '-' + who,
      sendType: 'user',
      sender: who,
      senderOpenDingTalkId: who,
      createTime: new Date(time).toISOString(),
      content,
    })
    const inquiry = message('participant', question, at)
    const response = {
      ...message('fixture-user', answer, at + 1),
      quotedMessage: { openMessageId: inquiry.openMessageId },
    }
    await writeFile(
      join(root, group + '.tmp'),
      JSON.stringify({
        success: true,
        result: {
          hasMore: false,
          conversationMessagesList: [
            {
              singleChat: false,
              openConversationId: group,
              title: group,
              messages: populated ? [response, inquiry] : [],
            },
          ],
        },
      })
    )
    await rename(join(root, group + '.tmp'), join(root, group + '.json'))
  }
}

/** DingTalk and the language model are protocol doubles. The desktop, host and storage are real. */
export function createDesktopScenario(options) {
  const dingtalk = createStandInDingTalkFixture(options)
  const history = join(options.resultDir, 'training-history')
  const model = createTrainingModel()
  let sequence = 0
  return {
    async prepareApp(context) {
      await dingtalk.prepareApp(context)
      await mkdir(history, { recursive: true })
      await publishHistory(history, false)
      context.appEnvironment.WEWORK_E2E_DINGTALK_TRAINING_HISTORY = history
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleModelMaintenanceRequest(body, response)) return true
      const events = model.respond(body)
      if (!events) return false
      const id = 'training-response-' + ++sequence
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const rpc = (method, args) => requestExecutor(control, method, args, options.uiTimeoutMs)
      const profile = () => rpc('runtime.stand_in.personal.get', { userId: USER })
      const role = settings => settings.roles.find(item => item.id === ROLE)
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: options.workbenchReadyTimeoutMs,
      })
      await dingtalk.install(control)
      const selected = (await rpc('runtime.runner.catalog', {})).models.find(
        item => item.runtime === 'codex' && item.is_default
      )
      assert.ok(selected, 'Expected the configured local test model')
      const previous = await profile()
      let arrangement
      try {
        const base = await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...previous,
            primary: {
              prompt: '',
              preferences: '',
              ...previous.primary,
              enabled: true,
              model: selected,
            },
            roles: [
              ...previous.roles,
              {
                id: ROLE,
                name: ROLE,
                prompt: ORIGINAL,
                version: 0,
                enabled: true,
                tags: [],
                executionDeviceId: previous.executionDeviceId,
                model: selected,
                collaboration: {
                  enabled: false,
                  allProjects: false,
                  projects: [],
                  excludedProjects: [],
                  tags: [],
                },
                connections: DEMONSTRATIONS.map(([name]) => source(name)),
              },
            ],
          },
        })
        assert.notEqual(
          role(base).selfLearningEnabled,
          true,
          'Connecting alone must not opt a role into learning'
        )
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('clickWhenEnabled', testId('personal-stand-in-button'))
        await control.command('clickWhenEnabled', testId('stand-in-overview-role-' + ROLE))
        await openStandInSettings(control)
        const toggle = testId('stand-in-self-learning-toggle')
        await control.command('waitFor', toggle + '[aria-checked="false"]')
        await control.command('clickWhenEnabled', toggle)
        await control.command('clickWhenEnabled', testId('stand-in-save'))
        await control.command('waitFor', testId('stand-in-profile-panel'), { visible: false })
        const optedIn = await profile()
        assert.equal(role(optedIn).selfLearningEnabled, true)
        assert.deepEqual(role(optedIn).connections, role(base).connections)
        assert.ok(
          role(optedIn).connections.every(connection => connection.policy.automatic === false)
        )
        await verifyLearningReport(
          control,
          options.captureScreenshot,
          '01-empty',
          {
            status: '还没有完成评测',
            metrics: { iterations: '0', current_score: '暂无', candidate_score: '暂无' },
          },
          { keepOpen: true }
        )
        await publishHistory(history, true)
        arrangement = await until(
          async () =>
            (await rpc('runtime.automations.list', {})).items.find(
              item =>
                item.taskRequest?.standInCalendar?.template === 'memory_review' &&
                item.taskRequest.standInOwner?.userId === USER
            ),
          Boolean,
          'The scheduler must provision the owner memory arrangement',
          45_000
        )
        await control.command('clearSystemNotifications', 'body')
        await control.command('blurMainWindow', 'body')
        await until(
          async () => JSON.parse(await control.command('getWindowFocusSnapshot', 'body')),
          snapshot => snapshot.tracker?.focused === false,
          'Wework must be unfocused before the memory review starts',
          options.uiTimeoutMs
        )
        const run = await rpc('runtime.automations.run_now', { automationId: arrangement.id })
        assert.ok(run.run.id)
        const cases = await until(
          async () =>
            (await rpc('runtime.stand_in.memory.list', { userId: USER })).items.filter(
              row => row.evidence?.trainingCase?.roleId === ROLE
            ),
          rows => rows.length === DEMONSTRATIONS.length,
          'The scheduled reviewer must save three evidence-backed owner demonstrations',
          options.modelResponseTimeoutMs
        )
        assert.deepEqual(
          cases.map(row => row.evidence.trainingCase.expected).sort(),
          DEMONSTRATIONS.map(([, , expected]) => expected).sort()
        )
        const pending = await until(
          () => rpc('runtime.stand_in.proposal.get', { userId: USER, roleId: ROLE }),
          proposal => proposal?.training?.evaluation?.length === 2,
          'Three observed owner demonstrations must produce an independently evaluated Ghost candidate',
          options.modelResponseTimeoutMs
        )
        assert.equal(pending.training.cases.length, DEMONSTRATIONS.length)
        const finished = await until(
          async () =>
            (
              await rpc('runtime.automation_runs.list', { automationId: arrangement.id })
            ).items.find(item => item.id === run.run.id),
          item => ['succeeded', 'failed', 'cancelled'].includes(item?.status),
          'The background memory review must finish before checking for alerts',
          options.modelResponseTimeoutMs
        )
        assert.equal(finished.status, 'succeeded', JSON.stringify(finished))
        assert.ok(finished.taskId, 'The memory review must retain its original task')
        model.verify()
        assert.equal(role(await profile()).prompt, ORIGINAL)
        const quietSince = Date.now()
        await until(
          async () => {
            const notifications = JSON.parse(
              await control.command('getSystemNotifications', 'body')
            )
            assert.deepEqual(
              notifications.filter(item =>
                [finished.taskId, 'stand-in-chat-' + USER + '-role-' + ROLE].includes(
                  item.address?.taskId
                )
              ),
              [],
              'Background memory consolidation and its suggested revision must stay silent'
            )
            return Date.now() - quietSince
          },
          elapsed => elapsed >= 1200,
          'Observe the native notification channel after the background review',
          options.uiTimeoutMs
        )
        // The notification assertion needs native blur. Report and proposal clicks use renderer
        // controls and only require a visible window.
        await verifyLearningReport(
          control,
          options.captureScreenshot,
          '02-pending',
          {
            status: '改进建议待确认',
            dimensions: { intent: '证据不足', verification: '0 → 100', clarity: '50 → 100' },
            metrics: {
              iterations: '1',
              current_score: '0',
              baseline_score: '0',
              candidate_score: '100',
              'score-change': '+100 分',
            },
          },
          { refresh: true, keepOpen: true }
        )
        const reportProposal = testId('stand-in-learning-view-proposal')
        await control.command('clickWhenEnabled', reportProposal, { timeoutMs: 10_000 })
        const proposalDialog = testId('stand-in-proposal-dialog')
        await control.command('waitFor', proposalDialog, { text: REVISED, timeoutMs: 5000 })
        await control.command('waitFor', testId('stand-in-profile-panel'), {
          visible: false,
          timeoutMs: 5000,
        })
        await options.captureScreenshot(control, 'learning-report-02a-review-from-report.png')
        await control.command('clickWhenEnabled', testId('stand-in-proposal-dialog-close'))
        await control.command('waitFor', proposalDialog, { visible: false, timeoutMs: 5000 })
        await openStandInDetails(control)
        await control.command('clickWhenEnabled', testId('stand-in-proposal-open'))
        const card = testId('stand-in-proposal')
        await control.command('waitFor', card, { text: REVISED })
        await control.command(
          'clickWhenEnabled',
          card + ' ' + testId('stand-in-ghost-evidence-toggle')
        )
        await control.command('waitFor', testId('stand-in-ghost-evidence'), {
          text: 'When did this first occur?',
        })
        await control.command('clickWhenEnabled', card + ' ' + testId('stand-in-proposal-accept'))
        const applied = await until(
          profile,
          value => role(value).prompt === REVISED,
          'Accepting the owner card must persist the trained Ghost',
          options.uiTimeoutMs
        )
        assert.deepEqual(role(applied).connections, role(optedIn).connections)
        assert.deepEqual(applied.primary, optedIn.primary)
        await verifyLearningReport(control, options.captureScreenshot, '03-accepted', {
          status: '已采纳改进建议',
          dimensions: { judgment: '证据不足', verification: '0 → 100' },
          metrics: {
            iterations: '1',
            current_score: '100',
            baseline_score: '0',
            candidate_score: '100',
          },
        })
        await openStandInMemory(control)
        const review = testId('stand-in-recent-review')
        for (const period of ['today', 'week']) {
          await control.command('clickWhenEnabled', testId('stand-in-review-' + period))
          await control.command('waitFor', review + ' h4', { text: '我的示范' })
          for (const [, scene] of DEMONSTRATIONS)
            await control.command('waitFor', review, {
              text: 'Ask about onset when handling ' + scene,
            })
          assert.equal(await control.command('getElementCount', review + ' li'), '3')
        }
        const rework = testId('stand-in-rework-review')
        await control.command('waitFor', rework + ' time', { timeoutMs: options.uiTimeoutMs })
        const measured = await rpc('runtime.stand_in.memory.rework_report', {
          userId: USER,
          roleId: ROLE,
        })
        assert.equal(measured.completeRequests, 0, 'Owner demonstrations have no delivered reply')
        assert.equal(measured.comparison.status, 'insufficient')
        assert.equal(
          await pathExists(join(history, 'unexpected-send')),
          false,
          'Offline training attempted an external send'
        )
        const works = (await rpc('runtime.stand_in.work.list', { userId: USER })).items
        assert.ok(
          !works.some(
            item => item.roleId === ROLE && item.source?.providerId === PROVIDER && item.task
          ),
          'Keeping connected history must not dispatch a reply task'
        )
        await control.command('clickWhenEnabled', testId('stand-in-memory-path-settings'))
        await control.command('clickWhenEnabled', testId('stand-in-close'))
        await control.command('waitFor', testId('stand-in-profile-panel'), { visible: false })
        await selectWorkbenchTheme(control, { mode: 'dark', themeId: 'wework' })
        await control.command('clickWhenEnabled', testId('stand-in-overview-role-' + ROLE))
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 375, height: 800 }),
        })
        await verifyLearningReport(
          control,
          options.captureScreenshot,
          '04-accepted-narrow-dark',
          {
            status: '已采纳改进建议',
            metrics: { iterations: '1', current_score: '100' },
          },
          { keepOpen: true }
        )
        await control.command('clickWhenEnabled', testId('stand-in-ghost-revision-undo'))
        await control.command('waitFor', testId('stand-in-learning-report'), {
          text: '已撤回本轮改进',
        })
        assert.equal(
          await control.command('getText', testId('stand-in-learning-current_score')),
          '0'
        )
        assert.equal(role(await profile()).prompt, ORIGINAL)
        await options.captureScreenshot(control, 'learning-report-05-undone.png')
      } finally {
        if (arrangement)
          await rpc('runtime.automations.toggle', { automationId: arrangement.id, enabled: false })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...previous, version: (await profile()).version },
        })
      }
    },
  }
}
