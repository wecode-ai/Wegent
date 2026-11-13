import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { DEFAULT_MODEL_ID } from './shared.mjs'
import { hasUserReplyAfterToolOutput } from './desktop-server.mjs'
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
      const kind = CASES.find(value => JSON.stringify(body.input).includes(prompt(value)))
      if (!kind) return false
      const output = toolOutputText(body, callId(kind))
      let items
      if (output === null) {
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
        const answered = hasUserReplyAfterToolOutput(body, callId(kind), answer(kind))
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
      const post = async (path, body) => {
        const response = await fetch(`${cloud.backendUrl}/api/runtime-work/${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        })
        assert.equal(response.ok, true, `Mobile ${path} failed: ${response.status}`)
        const result = await response.json()
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
        } else if (kind === 'async-running') {
          await until(
            () => runningModelHeld,
            value => value,
            'The async model did not remain active while awaiting mobile guidance',
            timeoutMs
          )
          assert.equal((await task(address))?.running, true)
          await post('guidance', { address, message: answer(kind), clientGuidanceId: randomUUID() })
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
      }
    },
    cleanup() {
      releaseRunning()
    },
  }
}
