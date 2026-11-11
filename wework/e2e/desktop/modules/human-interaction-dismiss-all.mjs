import assert from 'node:assert/strict'
import { selectedToolCall } from './model-tool-calls.mjs'
import {
  assistantMessage,
  createSse,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

const PROMPT = 'HUMAN_INTERACTIONS_DISMISS_ALL'
const QUESTIONS = ['批量忽略：确认发布范围？', '批量忽略：确认通知对象？']
const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const PAGE = `${ACTIVE} [data-testid="runtime-interactions-page"]`
const ORIGINAL = `${ACTIVE} [data-testid="desktop-workbench-surface"][aria-hidden="false"]`
const COMPOSER = `${ACTIVE} [data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]`

/** Model-only simulation; both questions use the real runtime and archive storage. */
export function handleDismissAllModel(body, response) {
  if (!JSON.stringify(body.input).includes(PROMPT)) return false
  const events = QUESTIONS.flatMap((question, index) => {
    const id = `${PROMPT}_${index}`
    return toolOutputText(body, id) === null
      ? selectedToolCall(
          id,
          selectTool(body, 'request_user_input_async', {
            questions: [{ title: question }],
          }),
          index
        )
      : []
  })
  response.end(
    createSse([
      responseCreated(PROMPT),
      ...(events.length ? events : [assistantMessage('两条问题等待你的判断。')]),
      responseCompleted(PROMPT),
    ])
  )
  return true
}

/** Reuses the existing CI checkpoint and app session; leaves the inbox on history. */
export async function verifyDismissAll(control, timeoutMs, taskId) {
  await control.command('click', `${PAGE} [data-testid="interaction-open-original"]`)
  await control.command('fill', COMPOSER, { value: PROMPT })
  const send = `${ORIGINAL} [data-testid="send-message-button"]:not(:disabled)`
  await control.command('waitFor', send)
  await control.command('click', send)
  await control.command('click', '[data-testid="workspace-tab-select-pending-interactions"]')
  await control.command('click', `${PAGE} [data-testid="interactions-history"]`)
  await control.command('waitFor', `${PAGE} [data-testid="interactions-pending-count"]`, {
    text: '2',
    timeoutMs,
  })
  for (const question of QUESTIONS)
    await control.command('waitFor', `${PAGE} [data-testid="interaction-list-item"]`, {
      text: question,
    })
  const readUserMessages = async () => {
    const transcript = await requestExecutor(
      control,
      'runtime.tasks.transcript',
      {
        taskId,
        includeFullContent: true,
        limit: 100,
      },
      timeoutMs
    )
    return transcript.messages.filter(message => message.role === 'user').map(message => message.id)
  }
  const before = await readUserMessages()
  await control.command('click', `${PAGE} [data-testid="interactions-dismiss-all"]`)
  await control.command('waitFor', `${PAGE} [data-testid="interactions-pending-count"]`, {
    text: '0',
  })
  await reloadMainWindow(control, 'Bulk dismissal must survive a renderer reload')
  await control.command('waitFor', `${PAGE} [data-testid="interactions-pending-count"]`, {
    text: '0',
  })
  assert.deepEqual(
    await readUserMessages(),
    before,
    'Bulk dismissal must not answer either question'
  )
  await control.command('click', `${PAGE} [data-testid="interactions-history"]`)
  for (const question of QUESTIONS)
    await control.command('waitFor', `${PAGE} [data-testid="interaction-list-item"]`, {
      text: question,
    })
}
