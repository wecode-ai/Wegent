import assert from 'node:assert/strict'

import { createSingleRootLocalProject } from '../modules/shared.mjs'

const ACTIVE_WORKSPACE_TAB_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'
const ACTIVE_WORKBENCH_SELECTOR =
  `${ACTIVE_WORKSPACE_TAB_SELECTOR} ` +
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const PLAN_PROMPT = 'WEWORK_DESKTOP_E2E_RUNNING_PLAN_HISTORY'
const PLAN_TITLE = 'Running conversation recovery plan'
const PLAN_PREFIX_ITEM = 'Preserve the generated prefix.'
const PLAN_PREFIX = `# ${PLAN_TITLE}\n\n- ${PLAN_PREFIX_ITEM}`
const PLAN_SUFFIX_ITEM = 'Continue streaming after the conversation reopens.'
const PLAN_SUFFIX = `\n- ${PLAN_SUFFIX_ITEM}`
const PLAN_COMPLETION = `<proposed_plan>\n${PLAN_PREFIX}${PLAN_SUFFIX}\n</proposed_plan>`

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function responseCreated(id) {
  return { type: 'response.created', response: { id } }
}

function responseCompleted(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  }
}

function streamingPlanEvents(id) {
  const itemId = `${id}-message`
  return {
    itemId,
    start: [
      responseCreated(id),
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: [],
          phase: 'final_answer',
        },
      },
      {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
    ],
    finish: [
      {
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text: PLAN_COMPLETION,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: PLAN_COMPLETION, annotations: [] }],
          phase: 'final_answer',
        },
      },
      responseCompleted(id),
    ],
  }
}

function outputTextDelta(itemId, delta, offset) {
  return {
    type: 'response.output_text.delta',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta,
    offset,
  }
}

async function waitForNewTaskRow(control, knownRows, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKSPACE_TAB_SELECTOR))
    const row = snapshot.testIds.find(
      testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
    )
    if (row) return row
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for the running plan task row')
}

async function assertRenderedPlanPrefix(control, timeoutMs, stableMs) {
  const selector = '[data-testid="assistant-plan-card"]'
  await control.command('waitFor', selector, {
    text: PLAN_TITLE,
    stableMs,
    timeoutMs,
  })
  const text = await control.command('getText', selector)
  assert.ok(text.includes(PLAN_TITLE), 'The running plan title was missing')
  assert.ok(text.includes(PLAN_PREFIX_ITEM), 'The running plan prefix item was missing')
}

export function createDesktopScenario({ uiTimeoutMs, workspacePath }) {
  let active = false
  let planPrefixWrittenResolve
  let releasePlanResponseResolve
  const planPrefixWritten = new Promise(resolve => {
    planPrefixWrittenResolve = resolve
  })
  const releasePlanResponse = new Promise(resolve => {
    releasePlanResponseResolve = resolve
  })

  return {
    async handleHttp(request, response, url) {
      if (!active || request.method !== 'POST') return false
      if (!['/v1/responses', '/responses'].includes(url.pathname)) return false

      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      if (!body.includes(PLAN_PROMPT)) return false

      const responseId = `wework-running-plan-history-${Date.now()}`
      const stream = streamingPlanEvents(responseId)
      const prefix = `<proposed_plan>\n${PLAN_PREFIX}`
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      })
      response.flushHeaders()
      response.write(sse(stream.start))
      response.write(sse([outputTextDelta(stream.itemId, prefix, 0)]))
      response.flush?.()
      planPrefixWrittenResolve()
      await releasePlanResponse
      response.write(
        sse([outputTextDelta(stream.itemId, `${PLAN_SUFFIX}\n</proposed_plan>`, prefix.length)])
      )
      response.end(sse(stream.finish))
      return true
    },

    async verify(control) {
      active = true
      let released = false
      try {
        await createSingleRootLocalProject(control, workspacePath, 'running-plan-history')
        await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
        const knownRows = new Set(
          JSON.parse(
            await control.command('snapshot', ACTIVE_WORKSPACE_TAB_SELECTOR)
          ).testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
        )

        await control.command('click', '[data-testid="quick-phrase-button"]')
        await control.command('waitFor', '[data-testid="quick-phrase-menu"]', {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', '[data-testid="quick-phrase-option-default-create-plan"]')
        await control.command('fill', COMPOSER_SELECTOR, { value: PLAN_PROMPT })
        await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
          timeoutMs: uiTimeoutMs,
        })
        await Promise.race([
          planPrefixWritten,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('The running plan prefix was not written')),
              uiTimeoutMs
            )
          ),
        ])

        const taskRowTestId = await waitForNewTaskRow(control, knownRows, uiTimeoutMs)
        await assertRenderedPlanPrefix(control, uiTimeoutMs)
        await control.command('waitFor', '[data-testid="assistant-plan-streaming-indicator"]', {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
        await control.command('clickWhenEnabled', `[data-testid="${taskRowTestId}"]`, {
          timeoutMs: uiTimeoutMs,
        })
        await assertRenderedPlanPrefix(control, uiTimeoutMs, 500)
        await control.command('waitFor', '[data-testid="assistant-plan-streaming-indicator"]', {
          timeoutMs: uiTimeoutMs,
        })

        released = true
        releasePlanResponseResolve()
        await control.command('waitFor', '[data-testid="assistant-plan-card"]', {
          text: PLAN_SUFFIX_ITEM,
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(
          Number(await control.command('getElementCount', '[data-testid="assistant-plan-card"]')),
          1,
          'The completed plan was duplicated after restoring its streaming prefix'
        )
      } finally {
        active = false
        if (!released) releasePlanResponseResolve()
      }
    },
  }
}
