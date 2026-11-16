import assert from 'node:assert/strict'
import { openStandInActivity } from '../modules/stand-in-profile-navigation.mjs'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { shellCommandResponse } from '../modules/shell-command-response.mjs'
import { findRuntimeWorkTask } from '../modules/runtime-task-evidence.mjs'
import { DEFAULT_MODEL_ID } from '../modules/shared.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { readStoryTaskEvidence } from '../modules/stand-in-private-story-evidence.mjs'
import { assertMarkdownPreviewAndSource } from '../modules/markdown-file-preview.mjs'
import {
  STORY_CHAT,
  STORY_PRIMARY,
  STORY_USER,
  assertStoryPrimaryOutcome,
  openStoryPrimary,
  storyUntil,
} from '../modules/stand-in-source-story-evidence.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from '../modules/response-protocol.mjs'
import {
  ORDERS_V1,
  ORDERS_V2,
  LAUNCH_ANSWER,
  LAUNCH_QUESTION,
  REVENUE_ANSWER,
  REVENUE_QUESTION,
  assertLaunchUnchanged,
  createDotsCheckedCommand,
  cartProgram,
  comparableDotsPath,
  dotsFileLink,
  followupProgram,
  launchProgram,
  launchReadProgram,
  prepareDotsFixtures,
  revenueProgram,
} from '../modules/dots-story-fixtures.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const INPUT_CARD = `${ACTIVE} [data-testid="request-user-input-card"]`
const REQUEST = (story, phase) => `DOTS_${story}_REQUEST_${phase}`
const WORK = (story, phase) => `DOTS_${story}_WORK_${phase}`
const RESULT = (story, phase) => `DOTS_${story}_RESULT_${phase}`
const TASK_TITLES = {
  CART: 'Customer cart feedback to tested fix',
  LAUNCH: 'Changed launch scope to reviewed beta pack',
  REVENUE: 'Updated orders to evidence-backed follow-up plan',
}

function latestUserText(body) {
  const item = (body.input ?? []).filter(entry => entry.role === 'user').at(-1)
  return typeof item?.content === 'string'
    ? item.content
    : (item?.content ?? []).map(part => part.text ?? '').join('')
}

function nativeCall(body, id, name, args) {
  return mcpToolRequestEvents(body, {
    toolName: name,
    directToolName: `mcp__wework_stand_in__${name}`,
    argumentsValue: args,
    searchCallId: `${id}-search`,
    toolCallId: id,
  }).events
}

export async function revealDotsFollowupHistory(control) {
  const previews = `${STORY_CHAT} [data-testid="message-turn-navigation-preview"]`
  const request = REQUEST('REVENUE', 2)
  await control.command('waitFor', previews, { text: request })
  const index = await control.command('getAttribute', previews, {
    text: request,
    value: 'data-turn-index',
  })
  assert.match(index, /^\d+$/, 'Locate the original phase-two request in real turn navigation')
  await control.command(
    'clickWhenEnabled',
    `${STORY_CHAT} [data-testid="message-turn-navigation-marker"][data-turn-index="${index}"]`
  )
  await control.command('scrollIntoViewAsUser', `${STORY_CHAT} [data-testid="message-user"]`, {
    text: request,
  })
  // Native delivery is a separate activity turn, not the manual request turn.
  const answers = `${STORY_CHAT} [data-testid="message-assistant"]`
  const result = RESULT('REVENUE', 2)
  await control.command('waitFor', answers, { text: result })
  await control.command('scrollIntoViewAsUser', answers, { text: result })
  const messageId = await control.command('getAttribute', answers, {
    text: result,
    value: 'data-message-id',
  })
  assert.ok(messageId, 'The original delivered plan must have a real message identity')
  return `${answers}[data-message-id=${JSON.stringify(messageId)}]`
}

/** Script model decisions only; primary delegation, execution, input and receipts stay native. */
export function createDesktopScenario(options) {
  const worktree = join(options.workspacePath, 'dots-linked-worktree')
  const root = join(worktree, 'stories')
  const tasks = new Map()
  const receipts = new Map()
  const observedReports = new Map()
  const completions = []
  let original
  let active = false
  let story = 'CART'
  let phase = 1
  let originalThread
  const rpc = (control, method, params) =>
    requestExecutor(control, method, params, options.uiTimeoutMs)
  const has = requestContainsToolOutput

  function command(body, id, source) {
    const verifiedSource = `const compareCwd=${comparableDotsPath.toString()};require('assert/strict').equal(compareCwd(require('fs').realpathSync(process.cwd())),compareCwd(require('fs').realpathSync(${JSON.stringify(root)})),'The native default task cwd must retain the selected stories subdirectory');${source}`
    const encoded = Buffer.from(verifiedSource).toString('base64')
    const cmd = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
    return shellCommandResponse(body, id, cmd, undefined, { yield_time_ms: 1000 })
  }

  const checkedCommand = createDotsCheckedCommand(command)

  function primary(body) {
    if (story === 'CART' && phase === 1) {
      const pending = checkedCommand(
        body,
        'dots-primary-cwd',
        "console.log('DOTS_PRIMARY_CWD_VERIFIED')",
        'DOTS_PRIMARY_CWD_VERIFIED'
      )
      if (pending) return pending
    }
    const id = `dots-${story}-${phase}-delegate`
    if (!has(body, id))
      return nativeCall(body, id, phase === 1 ? 'create_task' : 'continue_task', {
        requestId: id,
        ...(phase === 1 ? { title: TASK_TITLES[story] } : { taskId: tasks.get(story) }),
        message: `${WORK(story, phase)}: Work only inside ${root}; inspect source evidence and return actual verified outputs. Never publish or contact anyone.`,
      })
    const result = JSON.parse(readMcpToolOutput(body, id))
    assert.equal(result.success, true, 'The production task operation must actually succeed')
    if (phase === 1) tasks.set(story, result.taskId)
    else assert.equal(result.taskId, tasks.get(story), 'Continue the original delegated work')
    return [assistantMessage(`${TASK_TITLES[story]}: delegated to ${result.taskId}.`)]
  }

  function question(body, id, title, answer, alternatives) {
    if (!has(body, id))
      return selectedToolCall(
        id,
        selectTool(body, 'request_user_input_async', {
          questions: [{ title, options: alternatives }],
        })
      )
    assert.deepEqual(JSON.parse(toolOutputText(body, id)), { accepted: true })
    if (!JSON.stringify(body.input).includes(answer))
      return [assistantMessage(`Waiting for your decision. ${title}`)]
    return null
  }

  function worker(body) {
    const key = `dots-${story}-${phase}`
    let pending
    if (story === 'CART') {
      pending = checkedCommand(body, key, cartProgram(root, phase), `DOTS_CART_V${phase}_VERIFIED`)
    } else if (story === 'LAUNCH') {
      if (phase === 1) {
        pending = checkedCommand(
          body,
          `${key}-read`,
          launchReadProgram(root),
          'DOTS_LAUNCH_SOURCES_READ'
        )
        if (pending) return pending
        const source = checkedCommand.output(`${key}-read`)
        for (const fact of ['2026-11-20', 'Automatic scheduling deferred', 'Date not specified'])
          assert.ok(source.includes(fact), `Actual launch source must contain ${fact}`)
        pending = question(body, `${key}-question`, LAUNCH_QUESTION, LAUNCH_ANSWER, [
          'Keep November 20 for beta users only',
          'Postpone beta to November 27',
        ])
        if (pending) return pending
      }
      pending = checkedCommand(
        body,
        key,
        launchProgram(root, phase),
        `DOTS_LAUNCH_V${phase}_VERIFIED`
      )
    } else {
      pending = checkedCommand(
        body,
        key,
        revenueProgram(root, phase),
        phase === 3 ? 'DOTS_REVENUE_INVALID_AMOUNT' : `DOTS_REVENUE_V${phase}_VERIFIED`
      )
      if (pending) return pending
      if (phase === 2) {
        pending = question(body, `${key}-question`, REVENUE_QUESTION, REVENUE_ANSWER, [
          'Prioritize Cedar O4 pending 30000 cents',
          'Investigate Birch O2 refund 20000 cents first',
        ])
        if (pending) return pending
        pending = checkedCommand(
          body,
          `${key}-plan`,
          followupProgram(root),
          'DOTS_REVENUE_DECISION_IMPLEMENTED'
        )
      }
    }
    if (pending) return pending
    const file =
      story === 'CART'
        ? 'cart-fixture/cart-review.md'
        : story === 'LAUNCH'
          ? 'launch-fixture/announcement.md'
          : 'revenue-fixture/revenue-report.md'
    const text =
      phase === 3 && story === 'REVENUE'
        ? 'Validation error: Invalid amount: not-a-number. Previous report preserved; fix the CSV and continue.'
        : `Verified real files and command results. ${dotsFileLink(file, join(root, file))}`
    const extra =
      story === 'CART'
        ? `\n${dotsFileLink('cart.mjs', join(root, 'cart-fixture/cart.mjs'))}`
        : story === 'REVENUE' && phase === 2
          ? `\n${dotsFileLink('followup-plan.md', join(root, 'revenue-fixture/followup-plan.md'))}`
          : ''
    return [assistantMessage(`${RESULT(story, phase)}: ${text}${extra}`)]
  }

  async function send(control, text) {
    await openStoryPrimary(control)
    await control.command('fill', `${STORY_CHAT} [data-testid="chat-message-input"]`, {
      value: text,
    })
    await control.command('clickWhenEnabled', `${STORY_CHAT} [data-testid="send-message-button"]`)
  }

  async function start(control, name, revision, message) {
    story = name
    phase = revision
    console.log(`[dots-closed-loops] start ${story} revision ${phase}`)
    await send(control, `${REQUEST(story, phase)}: ${message}`)
    await storyUntil(
      () => tasks.get(story),
      Boolean,
      options.modelResponseTimeoutMs,
      'Delegate actual work'
    )
  }

  async function outcome(control) {
    await assertStoryPrimaryOutcome(
      control,
      (method, params) => rpc(control, method, params),
      RESULT(story, phase),
      options.modelResponseTimeoutMs
    )
    const taskId = tasks.get(story)
    const evidence = await storyUntil(
      () => readStoryTaskEvidence(options.executorHome, taskId),
      value =>
        value?.receipt &&
        value.receipt !== receipts.get(story) &&
        value.completion?.status === 'done',
      options.modelResponseTimeoutMs,
      'Read fresh native completion receipt'
    )
    const task = (await rpc(control, 'runtime.tasks.get', { taskId })).task
    const parent = (await rpc(control, 'runtime.tasks.get', { taskId: STORY_PRIMARY })).task
    const index = JSON.parse(
      await readFile(join(options.executorHome, 'runtime-work/index.json'), 'utf8')
    )
    completions.push({
      story,
      phase,
      taskId,
      threadId: evidence.threadId,
      lastTurnId: evidence.lastTurnId,
      completion: evidence.completion,
      receipt: evidence.receipt,
      workspaceSummaries: [parent, task].map(summary => ({
        taskId: summary.taskId,
        workspacePath: summary.workspacePath,
        workspaceKind: summary.workspaceKind,
        worktreeId: summary.worktreeId,
      })),
      executionSources: [STORY_PRIMARY, taskId].map(id => {
        const request = index.tasks[id].runtime_handle.executionRequest
        return {
          taskId: id,
          workspaceSource: request.workspace_source ?? null,
          projectWorkspacePath: request.project_workspace_path ?? null,
        }
      }),
    })
    for (const summary of [parent, task]) {
      assert.equal(
        comparableDotsPath(await realpath(summary.workspacePath)),
        comparableDotsPath(await realpath(root))
      )
      assert.equal(summary.workspaceKind, 'workspace')
      assert.ok(!summary.worktreeId, 'Current-workspace tasks must not claim a managed worktree')
    }
    assert.equal(task.status, 'done')
    assert.equal(evidence.completion.turnId, evidence.lastTurnId)
    assert.equal(evidence.completion.generation.delegation.sourceTaskId, STORY_PRIMARY)
    assert.equal(
      evidence.completion.generation.reportTo,
      null,
      'Direct task delegation reports through its captured delegation source, not a source-role reportTo'
    )
    if (phase > 1)
      assert.equal(evidence.threadId, originalThread, 'Same work must retain its owning thread')
    originalThread = evidence.threadId
    assert.ok(
      observedReports.get(evidence.receipt)?.includes(RESULT(story, phase)),
      'The exact persisted receipt must reach the primary after reading real child history'
    )
    receipts.set(story, evidence.receipt)
    await writeFile(
      join(options.resultDir, 'dots-closed-loop-completions.json'),
      JSON.stringify(completions, null, 2)
    )
    console.log(`[dots-closed-loops] verified ${story} revision ${phase}: real task ${taskId}`)
  }

  async function answer(control, title, answerText) {
    await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
    await openStandInActivity(control)
    const card = `[data-testid="stand-in-activity-task-${tasks.get(story)}"]`
    await control.command('waitFor', card, { timeoutMs: options.modelResponseTimeoutMs })
    await control.command('click', card)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-preview-open"]')
    await control.command('waitFor', INPUT_CARD, {
      text: title,
      visible: true,
      timeoutMs: options.modelResponseTimeoutMs,
    })
    await storyUntil(
      async () => {
        const task = findRuntimeWorkTask(
          JSON.parse(await control.command('getLocalRuntimeWork', 'body')),
          tasks.get(story)
        )
        return {
          taskId: task?.taskId,
          interactionStatus: task?.interactionStatus,
          running: task?.running,
          phase: task?.executionState?.phase,
        }
      },
      task => task.interactionStatus === 'awaitingUserReply',
      options.uiTimeoutMs,
      'The owning task must persist its unresolved business question'
    )
    if (story === 'LAUNCH') await assertLaunchUnchanged(root)
    else assert.equal(await readFile(join(root, 'revenue-fixture/followup-plan.md'), 'utf8'), '')
    await openStoryPrimary(control)
    const transcript = await rpc(control, 'runtime.tasks.transcript', {
      taskId: STORY_PRIMARY,
      limit: 100,
    })
    assert.ok(
      !transcript.messages.some(item => item.content?.includes(RESULT(story, phase))),
      'No successful delivery may precede the required business answer'
    )
    await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
    await openStandInActivity(control)
    await control.command('click', card)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-preview-open"]')
    await control.command('waitFor', INPUT_CARD, { text: title, visible: true })
    if (story === 'LAUNCH') await assertLaunchUnchanged(root)
    else assert.equal(await readFile(join(root, 'revenue-fixture/followup-plan.md'), 'utf8'), '')
    if (story === 'LAUNCH') {
      const beforeCancel = await rpc(control, 'runtime.tasks.transcript', {
        taskId: tasks.get(story),
        limit: 100,
      })
      await control.command(
        'click',
        `${INPUT_CARD} [data-testid="request-user-input-ignore-button"]`
      )
      await control.command('waitFor', `${ACTIVE} [data-testid="request-user-input-expand"]`)
      await assertLaunchUnchanged(root)
      const afterCancel = await rpc(control, 'runtime.tasks.transcript', {
        taskId: tasks.get(story),
        limit: 100,
      })
      assert.deepEqual(
        afterCancel.messages.filter(item => item.role === 'user').map(item => item.id),
        beforeCancel.messages.filter(item => item.role === 'user').map(item => item.id),
        'Cancelling the answer draft must not submit an arbitrary business decision'
      )
      await control.command('click', `${ACTIVE} [data-testid="request-user-input-expand"]`)
      await control.command('waitFor', INPUT_CARD, { text: title, visible: true })
    }
    await control.command(
      'fill',
      `${INPUT_CARD} [data-testid="request-user-input-custom-question_1"]`,
      { value: answerText }
    )
    await control.command(
      'clickWhenEnabled',
      `${INPUT_CARD} [data-testid="request-user-input-submit-button"]`
    )
  }
  async function preview(control, relative, text) {
    await openStoryPrimary(control)
    const messageScope =
      relative === 'followup-plan.md' ? await revealDotsFollowupHistory(control) : STORY_CHAT
    const path = join(
      root,
      relative === 'cart.mjs'
        ? 'cart-fixture/cart.mjs'
        : relative === 'followup-plan.md'
          ? 'revenue-fixture/followup-plan.md'
          : relative
    )
    const testId = relative === 'cart.mjs' ? 'assistant-markdown-link' : 'codex-reference-card'
    await control.command(
      'clickWhenEnabled',
      `${messageScope} [data-testid="${testId}"][aria-label*=${JSON.stringify(basename(path))}]`,
      { timeoutMs: 30_000 }
    )
    const pathSelector = '[data-testid="workspace-file-path"]'
    await control.command('waitFor', pathSelector, { visible: true })
    const expectedPath = comparableDotsPath(await realpath(path))
    await storyUntil(
      () => control.command('getText', pathSelector, { visible: true }),
      value => comparableDotsPath(value) === expectedPath,
      options.uiTimeoutMs,
      'The visible preview must resolve the exact canonical file path'
    )
    if (relative.endsWith('.md')) {
      await assertMarkdownPreviewAndSource(control, text, { visible: true })
    } else {
      await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
        text,
        visible: true,
      })
    }
  }

  async function persisted(control, marker) {
    const before = await readStoryTaskEvidence(options.executorHome, tasks.get(story))
    const ready = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await control.awaitReadyAfter(ready)
    await openStoryPrimary(control)
    await control.command('waitFor', STORY_CHAT + ' [data-testid="message-assistant"]', {
      text: marker,
    })
    const after = await readStoryTaskEvidence(options.executorHome, tasks.get(story))
    assert.equal(after.threadId, before.threadId)
    assert.equal(after.receipt, before.receipt)
    assert.equal(after.completion.turnId, before.completion.turnId)
    if (story !== 'CART') {
      const transcript = await rpc(control, 'runtime.tasks.transcript', {
        taskId: tasks.get(story),
        limit: 100,
      })
      assert.ok(
        JSON.stringify(transcript.messages).includes(
          story === 'LAUNCH' ? LAUNCH_ANSWER : REVENUE_ANSWER
        ),
        'The actual business decision must survive reload in the owning task'
      )
    }
  }
  return {
    diagnostics: () => ({
      story,
      phase,
      tasks: Object.fromEntries(tasks),
      receipts: Object.fromEntries(receipts),
      completions,
    }),
    reviewApproval: () => ({
      risk_level: 'low',
      user_authorization: 'high',
      outcome: 'allow',
      rationale: 'The owner requested edits and tests restricted to this isolated fixture.',
    }),
    async prepareApp() {
      execFileSync(
        'git',
        ['worktree', 'add', '-b', 'dots-current-workspace-fixture', worktree, 'HEAD'],
        {
          cwd: options.workspacePath,
          encoding: 'utf8',
        }
      )
      await prepareDotsFixtures(root)
      assert.equal((await stat(join(worktree, '.git'))).isFile(), true)
      assert.equal(
        comparableDotsPath(
          execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: root,
            encoding: 'utf8',
          }).trim()
        ),
        comparableDotsPath(await realpath(worktree))
      )
      const capabilities = join(options.executorHome, 'capabilities')
      await mkdir(capabilities, { recursive: true })
      await writeFile(
        join(capabilities, 'model-catalog-overrides.json'),
        JSON.stringify([
          {
            slug: DEFAULT_MODEL_ID,
            fields: { experimental_supported_tools: ['request_user_input_async'] },
          },
        ])
      )
      await rm(join(options.executorHome, 'codex', 'models_cache.json'), { force: true })
    },
    async handleHttp(req, response, url) {
      if (
        !active ||
        req.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(req)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const latest = latestUserText(body)
      let events = delegatedTaskResultEvents(body)
      if (events) {
        const receipt = latest.match(/^Wework delegated task result: resultId=([^,\s]+),/)
        if (receipt && JSON.stringify(events).includes(RESULT(story, phase)))
          observedReports.set(receipt[1], JSON.stringify(events))
      } else if (latest.includes(REQUEST(story, phase))) events = primary(body)
      else if (JSON.stringify(body.input).includes(WORK(story, phase))) events = worker(body)
      else if (latest.startsWith('Review this silent intake batch')) {
        const id = 'dots-intake'
        if (!has(body, id)) events = nativeCall(body, id, 'read_intake', {})
        else if (!has(body, `${id}-ignore`))
          events = nativeCall(body, `${id}-ignore`, 'ignore_events', {
            eventIds: JSON.parse(readMcpToolOutput(body, id)).snapshot.events.map(item => item.id),
            reason: 'These fixture tasks are handled through explicit owner requests.',
          })
        else events = [assistantMessage('No unrelated source work.')]
      } else return false
      const id = `dots-${story}-${phase}-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      active = true
      original = await rpc(control, 'runtime.stand_in.personal.get', { userId: STORY_USER })
      try {
        await control.command('ensureLocalModelCatalogReady', 'body', {
          timeoutMs: options.workbenchReadyTimeoutMs,
        })
        const catalog = await rpc(control, 'runtime.runner.catalog', {})
        const model = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
        assert.ok(model)
        await control.command('seedLocalProject', 'body', {
          value: JSON.stringify({
            projectKey: 'dots-closed-loops',
            name: 'Dots closed-loop QA',
            path: root,
          }),
        })
        await rpc(control, 'runtime.stand_in.personal.save', {
          userId: STORY_USER,
          settings: {
            ...original,
            primary: {
              ...original.primary,
              enabled: true,
              prompt: '',
              preferences: '',
              model,
              workspace: {
                projectKey: 'dots-closed-loops',
                workspacePath: root,
                executionMode: 'current_workspace',
              },
              connections: [],
            },
            roles: [],
          },
        })
        await rpc(control, 'runtime.stand_in.onboarding.complete', {
          userId: STORY_USER,
          weeklyReview: false,
        })
        await ensureExperimentalFeaturesEnabled(control)

        await start(
          control,
          'CART',
          1,
          'Read cart-fixture/feedback.md. Reproduce a failing quantity regression, fix cart.mjs, run Node tests and return the local reviewable patch.'
        )
        await outcome(control)
        assert.match(
          await readFile(join(root, 'cart-fixture/reproduced-failure.txt'), 'utf8'),
          /1700/
        )
        assert.match(
          await readFile(join(root, 'cart-fixture/passed-tests.txt'), 'utf8'),
          /# fail 0/
        )
        await start(
          control,
          'CART',
          2,
          'Continue that task: zero quantity must contribute zero. Add the regression and return verified results.'
        )
        await outcome(control)
        assert.match(
          await readFile(join(root, 'cart-fixture/cart.test.mjs'), 'utf8'),
          /zero quantity/
        )
        assert.match(
          await readFile(join(root, 'cart-fixture/passed-tests.txt'), 'utf8'),
          /# tests 4/
        )

        const cart = join(root, 'cart-fixture')
        const tested = execFileSync(
          process.execPath,
          ['--test', '--test-reporter=tap', 'cart.test.mjs'],
          {
            cwd: cart,
            encoding: 'utf8',
          }
        )
        assert.match(tested, /# tests 4/)
        assert.match(tested, /# fail 0/)
        const diff = execFileSync('git', ['diff', '--name-only'], { cwd: cart, encoding: 'utf8' })
          .trim()
          .split('\n')
          .sort()
        assert.deepEqual(diff, ['cart.mjs', 'cart.test.mjs'])
        const patch = execFileSync('git', ['diff'], { cwd: cart, encoding: 'utf8' })
        assert.match(patch, /item.quantity/)
        assert.match(patch, /zero quantity/)
        await preview(
          control,
          'cart-fixture/cart-review.md',
          'Zero quantity regression also passes.'
        )
        await preview(control, 'cart.mjs', 'item.unitPriceCents * item.quantity')
        await persisted(control, RESULT('CART', 2))
        await preview(
          control,
          'cart-fixture/cart-review.md',
          'Zero quantity regression also passes.'
        )
        await preview(control, 'cart.mjs', 'item.unitPriceCents * item.quantity')

        await start(
          control,
          'LAUNCH',
          1,
          'Compare scope-v1.md and scope-v2.md in launch-fixture. Ask for the missing date; leave existing assets unchanged until I answer. Then prepare all three launch assets.'
        )
        await answer(control, LAUNCH_QUESTION, LAUNCH_ANSWER)
        await outcome(control)
        for (const file of ['announcement.md', 'launch-checklist.md', 'scope-change-summary.md']) {
          const content = await readFile(join(root, 'launch-fixture', file), 'utf8')
          assert.match(content, /2026-11-20|November 20/)
          assert.match(content, /beta/)
          assert.match(content, /CSV export/)
          assert.match(content, /scheduling.*deferred/i)
        }
        await start(
          control,
          'LAUNCH',
          2,
          'Continue the same work. Add the explicit sentence No automatic scheduling in this beta to announcement.md, retaining the agreed date and audience.'
        )
        await outcome(control)
        assert.match(
          await readFile(join(root, 'launch-fixture/announcement.md'), 'utf8'),
          /No automatic scheduling in this beta/
        )

        await preview(
          control,
          'launch-fixture/announcement.md',
          'No automatic scheduling in this beta.'
        )
        await persisted(control, RESULT('LAUNCH', 2))
        await preview(
          control,
          'launch-fixture/announcement.md',
          'No automatic scheduling in this beta.'
        )

        await start(
          control,
          'REVENUE',
          1,
          'Read revenue-fixture/orders.csv, verify 30000 paid and 5000 pending, and write a reproducible script and report.'
        )
        await outcome(control)
        await writeFile(join(root, 'revenue-fixture/orders.csv'), ORDERS_V2)
        await start(
          control,
          'REVENUE',
          2,
          'New evidence is in orders.csv: Birch refunded, Cedar pending added. Continue the same analysis, recompute amounts and decline, ask which follow-up to prioritize, and write an internal plan after my answer.'
        )
        await answer(control, REVENUE_QUESTION, REVENUE_ANSWER)
        await outcome(control)
        const report = await readFile(join(root, 'revenue-fixture/revenue-report.md'), 'utf8')
        for (const fact of [
          'paid: 10000',
          'refunded: 20000',
          'pending: 35000',
          'total: 65000',
          '20000 cents (66.67%)',
        ])
          assert.ok(report.includes(fact), fact)
        const plan = await readFile(join(root, 'revenue-fixture/followup-plan.md'), 'utf8')
        assert.match(plan, /^1\. Review Cedar order O4: 30000 cents pending/)
        assert.match(plan, /No customer has been contacted/)
        await writeFile(
          join(root, 'revenue-fixture/orders.csv'),
          ORDERS_V2.replace('Cedar,30000', 'Cedar,not-a-number')
        )
        await start(
          control,
          'REVENUE',
          3,
          'The amount field is malformed. Validate input and report the error without overwriting a previously valid report.'
        )
        await outcome(control)
        assert.equal(
          await readFile(join(root, 'revenue-fixture/revenue-report.md'), 'utf8'),
          report
        )
        await writeFile(join(root, 'revenue-fixture/orders.csv'), ORDERS_V2)
        await start(
          control,
          'REVENUE',
          4,
          'The invalid amount has been corrected. Continue the original task and recalculate the report.'
        )
        await outcome(control)
        assert.equal(
          await readFile(join(root, 'revenue-fixture/revenue-report.md'), 'utf8'),
          report
        )
        assert.equal(await readFile(join(root, 'revenue-fixture/orders-v1.csv'), 'utf8'), ORDERS_V1)
        const recomputed = execFileSync(process.execPath, ['analyze.mjs'], {
          cwd: join(root, 'revenue-fixture'),
          encoding: 'utf8',
        })
        assert.deepEqual(JSON.parse(recomputed), {
          paid: 10000,
          refunded: 20000,
          pending: 35000,
          total: 65000,
        })
        await preview(
          control,
          'revenue-fixture/revenue-report.md',
          'Paid decline: 20000 cents (66.67%)'
        )
        await preview(control, 'followup-plan.md', 'No customer has been contacted.')
        await persisted(control, RESULT('REVENUE', 4))
        await preview(
          control,
          'revenue-fixture/revenue-report.md',
          'Paid decline: 20000 cents (66.67%)'
        )
        await preview(control, 'followup-plan.md', 'No customer has been contacted.')
      } finally {
        if (original) {
          const current = await rpc(control, 'runtime.stand_in.personal.get', {
            userId: STORY_USER,
          })
          await rpc(control, 'runtime.stand_in.personal.save', {
            userId: STORY_USER,
            settings: { ...original, version: current.version },
          })
        }
        for (const taskId of tasks.values()) {
          const result = await rpc(control, 'runtime.tasks.archive', { taskId })
          assert.equal(result.accepted, true)
        }
        active = false
      }
    },
  }
}
