import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { modelRequestTexts, readPreparedQuestionAttachmentPath } from './model-tool-output.mjs'
import { until } from './plugin-regression-fixture.mjs'
import { runtimeTranscriptBlocks } from './runtime-transcript-evidence.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  CLOUD_DEVICE_ID,
  CLOUD_PUBLIC_MODEL_NAME,
  CLOUD_PUBLIC_MODEL_OPTIONS,
  fetchJson,
} from './shared.mjs'
import {
  assistantMessage,
  selectedToolCall,
  selectTool,
  requestContainsToolOutput,
  toolOutputText,
} from './response-protocol.mjs'

const PROMPT = 'WEWORK_CLOUD_BLOCKING_QUESTION_FILES'
const CONTENT = 'CLOUD_BLOCKING_QUESTION_REAL_FILE_BYTES'
const FILE = 'cloud-question-brief.txt'
const DONE = 'CLOUD_BLOCKING_QUESTION_FILES_COMPLETE'
const COMPLETE = 'CLOUD_HTTP_QUESTION_FILES_COMPLETE'
const CARD = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`
const CASES = [
  { kind: 'socket', prompt: PROMPT, content: CONTENT, questionId: 'brief' },
  {
    kind: 'blocking-http',
    prompt: 'WEWORK_CLOUD_HTTP_BLOCKING_QUESTION_FILES',
    content: 'CLOUD_HTTP_BLOCKING_QUESTION_REAL_BYTES',
    questionId: 'brief',
  },
  {
    kind: 'async-http',
    prompt: 'WEWORK_CLOUD_HTTP_ASYNC_QUESTION_FILES',
    content: 'CLOUD_HTTP_ASYNC_QUESTION_REAL_BYTES',
    questionId: 'question_1',
    async: true,
  },
]
const callId = fixture => `cloud-question-files-${fixture.kind}`
const readId = fixture => `cloud-question-read-${fixture.kind}`

function questionCall(body, fixture, outputIndex = 0) {
  return selectedToolCall(
    callId(fixture),
    selectTool(body, fixture.async ? 'request_user_input_async' : 'request_user_input', {
      questions: fixture.async
        ? [{ title: fixture.prompt }]
        : [
            {
              id: fixture.questionId,
              header: 'Brief',
              question: fixture.prompt,
              options: [
                { label: 'Review', description: 'Review the attached brief' },
                { label: 'Revise', description: 'Revise the attached brief' },
              ],
            },
          ],
    }),
    outputIndex
  )
}

function readQuestionFile(body, fixture) {
  const grouped = fixture.async
    ? modelRequestTexts(body, 'user').match(/^Question answers:\n(\{[\s\S]*?\n\})/m)?.[1]
    : null
  if (fixture.async) {
    assert.deepEqual(JSON.parse(toolOutputText(body, callId(fixture))), { accepted: true })
    if (!grouped) return [assistantMessage('Waiting for the remote answer.')]
  }
  const answers = fixture.async
    ? JSON.parse(grouped)
    : JSON.parse(toolOutputText(body, callId(fixture))).answers
  const path = readPreparedQuestionAttachmentPath(answers[fixture.questionId].answers, FILE)
  const quoted = `'${path.replaceAll("'", "'\\''")}'`
  return selectedToolCall(
    readId(fixture),
    selectTool(body, 'exec_command', {
      cmd: `node -e "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))" ${quoted}`,
      max_output_tokens: 200,
    })
  )
}

// One existing cloud task exercises Socket and HTTP through the same native
// channel. Only the model is scripted; upload, download and file reads are real.
export function createCloudQuestionAttachments({ modelResponseTimeoutMs }) {
  const verified = new Set()
  return {
    respond(body) {
      if (!modelRequestTexts(body).includes(PROMPT)) return undefined
      for (const [index, fixture] of CASES.entries()) {
        if (!requestContainsToolOutput(body, callId(fixture))) {
          return [...(index === 1 ? [assistantMessage(DONE)] : []), ...questionCall(body, fixture)]
        }
        if (!requestContainsToolOutput(body, readId(fixture)))
          return readQuestionFile(body, fixture)
        assert.ok(
          toolOutputText(body, readId(fixture)).includes(fixture.content),
          `The real cloud Executor must read the ${fixture.kind} uploaded bytes`
        )
        verified.add(fixture.kind)
      }
      return [assistantMessage(COMPLETE)]
    },
    async verify(cloud, control) {
      const request = (path, body) =>
        fetchJson(`${cloud.backendUrl}${path}`, {
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'Content-Type': 'application/json',
          },
        })
      const teams = await request('/api/teams?page=1&limit=100')
      assert.ok(teams.items?.[0]?.id)
      const workspacePath = join(cloud.runtimeWorkspaceRoot, `question-files-${process.pid}`)
      await mkdir(workspacePath, { recursive: true })
      const created = await request('/api/runtime-work/create', {
        deviceId: CLOUD_DEVICE_ID,
        workspacePath,
        teamId: teams.items[0].id,
        runtime: 'codex',
        message: PROMPT,
        title: 'Cloud question attachments across Socket and HTTP',
        modelId: CLOUD_PUBLIC_MODEL_NAME,
        modelType: 'public',
        modelOptions: { ...CLOUD_PUBLIC_MODEL_OPTIONS, collaboration_mode: 'plan' },
        modelSelection: {
          modelName: CLOUD_PUBLIC_MODEL_NAME,
          modelType: 'public',
          options: { ...CLOUD_PUBLIC_MODEL_OPTIONS, collaboration_mode: 'plan' },
        },
      })
      assert.equal(created.accepted, true, created.error)
      const address = { deviceId: CLOUD_DEVICE_ID, taskId: created.taskId, workspacePath }
      const query = new URLSearchParams({ deviceId: CLOUD_DEVICE_ID, taskId: created.taskId })
      await control.command('navigate', 'body', { value: `/runtime-tasks?${query}` })
      await verifySocketAnswer(control, modelResponseTimeoutMs)
      assert.ok(verified.has('socket'))
      for (const fixture of CASES.slice(1)) {
        await verifyHttpQuestionAttachment(cloud, request, address, fixture, modelResponseTimeoutMs)
        assert.ok(verified.has(fixture.kind), `The native model must read ${fixture.kind} bytes`)
      }
      const task = await cloud.waitForRuntimeTask(address)
      assert.equal(task.status, 'done')
    },
  }
}

async function verifySocketAnswer(control, timeoutMs) {
  await control.command('waitFor', CARD, { text: PROMPT, timeoutMs })
  const input = `${CARD} [data-testid="request-user-input-custom-brief"]`
  await control.command('fill', input, { value: 'Review the brief\nPreserve both lines' })
  await control.command('pasteFile', input, {
    filename: FILE,
    mimeType: 'text/plain',
    value: Buffer.from(CONTENT).toString('base64'),
  })
  await control.command('waitFor', `${CARD} [data-testid="attachment-badge"]`, { text: FILE })
  await control.command(
    'clickWhenEnabled',
    `${CARD} [data-testid="request-user-input-submit-button"]`
  )
  await control.command(
    'waitFor',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
    { text: DONE, timeoutMs }
  )
}

async function uploadQuestionFile(cloud, fixture, timeoutMs) {
  const form = new FormData()
  form.set('file', new Blob([fixture.content], { type: 'text/plain' }), FILE)
  const uploaded = await fetch(`${cloud.backendUrl}/api/attachments/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.authToken}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  assert.equal(uploaded.status, 200, 'The real question attachment upload must succeed')
  const attachment = await uploaded.json()
  assert.ok(Number.isInteger(attachment.id) && attachment.id > 0)
  assert.equal(attachment.status, 'ready')
  return attachment.id
}

// Backend resolves the uploaded ID and intentionally omits executionRequest.
async function verifyHttpQuestionAttachment(cloud, request, address, fixture, timeoutMs) {
  const transcript = () =>
    request('/api/runtime-work/transcript', { ...address, limit: 100, includeFullContent: true })
  const question = value =>
    runtimeTranscriptBlocks(value).find(block => {
      const payload = block.render_payload
      return (
        payload?.kind === 'request_user_input' &&
        payload.questions?.some(item => item.question === fixture.prompt) &&
        (fixture.async
          ? payload.delivery === 'async' && payload.response == null
          : payload.interactionStatus === 'pending')
      )
    })?.render_payload
  const pending = await until(
    transcript,
    value => Boolean(question(value)),
    `The ${fixture.kind} question was not published`,
    timeoutMs
  )
  const payload = question(pending)
  assert.ok(payload.itemId && payload.interactionScope, 'HTTP answers require question identity')
  if (fixture.async) {
    assert.equal(payload.delivery, 'async')
    // The answer starts a new execution after the native question turn settles.
    const waiting = await cloud.waitForRuntimeTask(address)
    assert.equal(waiting.status, 'done')
  } else {
    assert.ok(payload.requestId !== undefined, 'Blocking answers require the native request ID')
  }
  const id = await uploadQuestionFile(cloud, fixture, timeoutMs)
  const sent = await request('/api/runtime-work/send', {
    address,
    message: 'Review the remote brief',
    attachmentIds: [id],
    requestUserInputResponse: {
      ...(!fixture.async ? { requestId: payload.requestId } : {}),
      itemId: payload.itemId,
      interactionScope: payload.interactionScope,
      ...(fixture.async ? { delivery: 'async' } : {}),
      answers: {
        [fixture.questionId]: { answers: ['Review the remote brief'], attachments: [{ id }] },
      },
    },
  })
  assert.equal(sent.accepted, true, sent.error)
  const next = fixture.async ? COMPLETE : CASES[2].prompt
  await until(
    transcript,
    value => JSON.stringify(value.turns).includes(next),
    `The native executor did not read the ${fixture.kind} uploaded bytes`,
    timeoutMs
  )
}
