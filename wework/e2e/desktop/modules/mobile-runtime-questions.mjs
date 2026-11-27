import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { visibleRuntimeUserMessage } from '../../../../packages/chat-core/src/runtime-user-message.js'
import { DEFAULT_MODEL_ID } from './shared.mjs'
import { hasUserReplyAfterToolOutput, inputUserMessageTexts } from './desktop-server.mjs'
import { setNativeCatalogOverride } from './model-catalog-recovery.mjs'
import { until } from './plugin-regression-fixture.mjs'
import { runtimeTranscriptBlocks } from './runtime-transcript-evidence.mjs'
import {
  assistantMessage,
  createSse,
  responseCompleted,
  responseCreated,
  selectedToolCall,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'

const CASES = ['blocking', 'async-running', 'async-idle', 'skip']
const prompt = kind => `WEWORK_MOBILE_QUESTION_${kind.toUpperCase()}`
const question = kind => `How should the mobile ${kind} task continue?`
const callId = kind => `mobile-question-${kind}`
const answer = kind => `Complete the ${kind} interaction`
const completion = kind => `${prompt(kind)}_COMPLETE`
const GUIDANCE_FILE = 'mobile-guidance.txt'
const GUIDANCE_FILE_CONTENT = 'WEWORK_MOBILE_GUIDANCE_ATTACHMENT_BYTES'
const REVISED_GUIDANCE = 'Use the attached brief for the revised mobile guidance'
const CORRECTION_PROMPT = `Continue using this revised guidance:\n\n${REVISED_GUIDANCE}`
const CORRECTION_COMPLETE = 'WEWORK_MOBILE_GUIDANCE_CORRECTION_COMPLETE'
const decode = value =>
  value?.encoding === 'gzip+base64+json'
    ? JSON.parse(gunzipSync(Buffer.from(value.payload, 'base64')).toString('utf8'))
    : value
const questionBlocks = (transcript, kind) =>
  runtimeTranscriptBlocks(transcript).filter(
    block =>
      block.render_payload?.kind === 'request_user_input' &&
      block.render_payload.questions?.some(item => item.question === question(kind))
  )

async function uploadGuidanceFile(cloud, timeoutMs) {
  const form = new FormData()
  form.set('file', new Blob([GUIDANCE_FILE_CONTENT], { type: 'text/plain' }), GUIDANCE_FILE)
  const response = await fetch(`${cloud.backendUrl}/api/attachments/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.authToken}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  assert.equal(response.status, 200, 'The real mobile guidance attachment upload must succeed')
  const attachment = await response.json()
  assert.equal(attachment.status, 'ready')
  assert.ok(Number.isInteger(attachment.id) && attachment.id > 0)
  return attachment.id
}

async function verifyGuidanceCorrection({
  request,
  transcript,
  task,
  address,
  modelSelection,
  guidance,
  timeoutMs,
}) {
  const visibleUsers = value =>
    value.messages.filter(message => message.role === 'user' && !message.suppressedUserMessage)
  const readHttpTranscript = refresh =>
    request('transcript', { ...address, limit: 20, includeFullContent: true, refresh })
  const originalUsers = visibleUsers(await readHttpTranscript(false))
  const original = originalUsers.find(message => message.clientUserMessageId === guidance.id)
  assert.ok(original?.runtimeGuidance, 'The remote transcript must identify the original guidance')
  assert.ok(
    original.attachments?.some(file => file.id === guidance.attachmentId),
    'The original remote guidance must have the uploaded attachment'
  )

  const corrected = await request('send', {
    address,
    message: CORRECTION_PROMPT,
    clientUserMessageId: randomUUID(),
    guidanceCorrection: { clientGuidanceId: guidance.id, content: REVISED_GUIDANCE },
    attachmentIds: [guidance.attachmentId],
    modelSelection,
  })
  assert.equal(corrected.accepted, true, JSON.stringify(corrected))
  await until(
    () => transcript(address),
    value => JSON.stringify(value).includes(CORRECTION_COMPLETE),
    'The owning Executor did not complete the remote guidance correction',
    timeoutMs
  )
  await until(
    () => task(address),
    value => value?.running === false,
    'The remote guidance correction turn did not finish',
    timeoutMs
  )
  const refreshed = await readHttpTranscript(true)
  const revisedUsers = visibleUsers(refreshed)
  assert.deepEqual(
    revisedUsers.map(message => message.id),
    originalUsers.map(message => message.id),
    'The correction must preserve the order and identity of user rows without a separate prompt'
  )
  const revised = revisedUsers.find(message => message.clientUserMessageId === guidance.id)
  assert.ok(
    revised?.runtimeGuidance,
    'The original guidance identity must survive transcript refresh'
  )
  assert.equal(revised.turnId, original.turnId)
  assert.equal(revised.content, REVISED_GUIDANCE)
  assert.ok(
    revised.attachments?.some(
      file => file.id === guidance.attachmentId && file.filename === GUIDANCE_FILE
    ),
    'The original guidance attachment must survive transcript refresh'
  )
  for (const reply of [completion('async-running'), CORRECTION_COMPLETE]) {
    assert.ok(
      refreshed.messages.some(
        message => message.role === 'assistant' && message.content?.includes(reply)
      ),
      `The refreshed transcript lost the assistant reply ${reply}`
    )
  }
}

// Exercise Mobile's HTTP contract through the existing real cloud/APP runtime.
// Only responses from the model are simulated, as in the surrounding checkpoint.
export function createMobileRuntimeQuestions() {
  let releaseRunning
  const runningGate = new Promise(resolve => {
    releaseRunning = resolve
  })
  let runningModelHeld = false

  return {
    async handleModel(body, response) {
      const userMessages = inputUserMessageTexts(body)
      const correction = userMessages.find(text => text.includes(CORRECTION_PROMPT))
      const kind = CASES.find(value => JSON.stringify(body.input).includes(prompt(value)))
      if (!kind && !correction) return false
      const output = kind ? toolOutputText(body, callId(kind)) : null
      let items
      if (correction) {
        assert.ok(
          correction.includes(GUIDANCE_FILE_CONTENT),
          'The correction must deliver the real attachment bytes'
        )
        items = [assistantMessage(CORRECTION_COMPLETE)]
      } else if (output === null) {
        const isAsync = kind.startsWith('async-')
        const tool = selectTool(body, isAsync ? 'request_user_input_async' : 'request_user_input', {
          questions: isAsync
            ? [{ title: question(kind), options: ['Minimal', answer(kind)] }]
            : [
                {
                  header: 'Direction',
                  id: 'direction',
                  question: question(kind),
                  options: [
                    { label: 'Minimal', description: 'Make the smallest change.' },
                    { label: answer(kind), description: 'Complete the interaction.' },
                  ],
                },
              ],
        })
        items = selectedToolCall(callId(kind), tool)
      } else if (kind.startsWith('async-')) {
        assert.deepEqual(JSON.parse(output), { accepted: true })
        const expectedAnswer =
          kind === 'async-running'
            ? userMessages
                .map(visibleRuntimeUserMessage)
                .find(
                  text =>
                    text.startsWith(`${answer(kind)}\n\n`) && text.includes(GUIDANCE_FILE_CONTENT)
                )
            : answer(kind)
        const answered =
          expectedAnswer && hasUserReplyAfterToolOutput(body, callId(kind), expectedAnswer)
        if (kind === 'async-running' && !answered) {
          runningModelHeld = true
          await runningGate
        }
        items = [assistantMessage(answered ? completion(kind) : `${prompt(kind)}_WAITING`)]
      } else {
        assert.deepEqual(
          JSON.parse(output),
          {
            answers: kind === 'skip' ? {} : { direction: { answers: [answer(kind)] } },
          },
          'The native tool must receive the exact mobile answer or cancellation'
        )
        items = [assistantMessage(completion(kind))]
      }
      const id = randomUUID()
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...items, responseCompleted(id)]))
      return true
    },

    async verify({ cloud, control, rpc, route, models, timeoutMs }) {
      const model = models.find(
        item => item.runtime === 'codex' && item.model_id === DEFAULT_MODEL_ID
      )
      assert.ok(model, 'The authorized APP catalog must expose the native E2E model')
      await setNativeCatalogOverride(
        control,
        DEFAULT_MODEL_ID,
        {
          experimental_supported_tools: ['request_user_input_async'],
        },
        timeoutMs
      )
      const modelSelection = {
        modelName: model.model_id,
        modelType: 'runtime',
        options: { runnerModelProvider: model.provider },
      }
      const request = async (path, body) => {
        const response = await fetch(`${cloud.backendUrl}/api/runtime-work/${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        assert.equal(response.ok, true, `Mobile ${path} failed: ${response.status}`)
        return response.json()
      }
      const post = async (path, body) => {
        const result = await request(path, body)
        assert.equal(result.accepted, true, JSON.stringify(result))
        return result
      }
      const transcript = async address => {
        const result = await rpc('runtime.tasks.transcript', address)
        assert.equal(result.ok, true, JSON.stringify(result.error))
        return decode(result.result)
      }
      const task = async address => {
        const result = await rpc('runtime.tasks.list')
        assert.equal(result.ok, true, JSON.stringify(result.error))
        return (decode(result.result).workspaces ?? [])
          .flatMap(workspace => workspace.tasks ?? [])
          .find(item => (item.taskId ?? item.localTaskId ?? item.id) === address.taskId)
      }

      for (const kind of CASES) {
        const taskId = randomUUID()
        const guidance =
          kind === 'async-running'
            ? { id: randomUUID(), attachmentId: await uploadGuidanceFile(cloud, timeoutMs) }
            : null
        const created = await post('create', {
          schemaVersion: 2,
          deviceId: route,
          taskId,
          standaloneChatWorkspace: true,
          workspaceKind: 'chat',
          runtime: 'codex',
          message: prompt(kind),
          modelId: modelSelection.modelName,
          modelType: modelSelection.modelType,
          modelOptions: modelSelection.options,
          modelSelection,
        })
        const address = {
          deviceId: route,
          taskId,
          workspacePath: created.workspacePath,
          runtime: 'codex',
        }
        const pending = await until(
          () => transcript(address),
          value =>
            questionBlocks(value, kind).some(block =>
              kind.startsWith('async-')
                ? block.render_payload.delivery === 'async'
                : block.render_payload.interactionStatus === 'pending'
            ),
          `The remote reader did not restore the ${kind} question`,
          timeoutMs
        )
        const payload = questionBlocks(pending, kind).find(
          block => kind.startsWith('async-') || block.render_payload.interactionStatus === 'pending'
        ).render_payload

        if (kind === 'skip') {
          await post('cancel', address)
          await until(
            () => task(address),
            value => value && value.running === false,
            'Skipping a mobile question did not stop its native turn',
            timeoutMs
          )
          const restored = await transcript(address)
          assert.ok(
            questionBlocks(restored, kind).every(
              block =>
                block.status !== 'pending' && block.render_payload.interactionStatus !== 'pending'
            ),
            'The skipped question reopened when its canonical transcript was read'
          )
          continue
        }
        if (kind === 'blocking') {
          assert.ok(
            payload.requestId !== undefined && payload.interactionScope,
            'A mobile answer requires the real scoped native request identity'
          )
          await post('send', {
            address,
            message: answer(kind),
            requestUserInputResponse: {
              requestId: payload.requestId,
              itemId: payload.itemId,
              interactionScope: payload.interactionScope,
              answers: { direction: { answers: [answer(kind)] } },
            },
          })
        } else if (guidance) {
          await until(
            () => runningModelHeld,
            value => value,
            'The async model did not remain active while awaiting mobile guidance',
            timeoutMs
          )
          assert.equal((await task(address))?.running, true)
          await post('guidance', {
            address,
            message: answer(kind),
            clientGuidanceId: guidance.id,
            attachmentIds: [guidance.attachmentId],
          })
          releaseRunning()
        } else {
          await until(
            () => task(address),
            value => value && value.running === false,
            'The async question turn did not settle before the mobile reply',
            timeoutMs
          )
          await post('send', {
            address,
            message: answer(kind),
            clientUserMessageId: randomUUID(),
            modelSelection,
          })
        }
        await until(
          () => transcript(address),
          value => JSON.stringify(value).includes(completion(kind)),
          `The native model did not receive the mobile ${kind} answer`,
          timeoutMs
        )
        await until(
          () => task(address),
          value => value && value.running === false,
          'The mobile question task did not finish',
          timeoutMs
        )
        const restored = await transcript(address)
        assert.ok(
          JSON.stringify(restored).includes(completion(kind)),
          'The completed canonical transcript lost the model reply'
        )
        if (kind === 'blocking') {
          assert.ok(
            questionBlocks(restored, kind).some(
              block =>
                block.render_payload.response?.answers?.direction?.answers?.[0] === answer(kind)
            ),
            'The canonical transcript lost the structured mobile answer'
          )
        } else {
          assert.ok(
            restored.messages.some(
              message => message.role === 'user' && message.content?.includes(answer(kind))
            ),
            'The async answer was not persisted as a user message'
          )
        }
        if (guidance) {
          await verifyGuidanceCorrection({
            request,
            transcript,
            task,
            address,
            modelSelection,
            guidance,
            timeoutMs,
          })
        }
      }
    },
    cleanup() {
      releaseRunning()
    },
  }
}
