import { selectedToolCall } from './model-tool-calls.mjs'
import assert from 'node:assert/strict'
import {
  assistantMessage,
  createSse,
  functionCall,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { requestExecutor } from './executor-rpc.mjs'

const CASES = [
  { mode: 'external', question: '请确认原会话处理后自动归档。' },
  { mode: 'dismiss', question: '这条问题暂不处理。' },
]
const PREFIX = 'HUMAN_INTERACTIONS_ARCHIVE_'
const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const PAGE = `${ACTIVE} [data-testid="runtime-interactions-page"]`
const ORIGINAL = `${ACTIVE} [data-testid="desktop-workbench-surface"][aria-hidden="false"]`
const COMPOSER = `${ACTIVE} [data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]`

/** Only the model is simulated; question persistence and UI routing stay real. */
export function handleArchiveInteractionModel(body, response) {
  const input = JSON.stringify(body.input)
  const current = CASES.filter(item => input.includes(PREFIX + item.mode)).sort(
    (a, b) => input.lastIndexOf(PREFIX + b.mode) - input.lastIndexOf(PREFIX + a.mode)
  )[0]
  if (!current) return false
  const id = PREFIX + current.mode
  const output = toolOutputText(body, id)
  const items =
    output === null
      ? (() => {
          const tool = selectTool(body, 'request_user_input_async', {
            questions: [{ title: current.question }],
          })
          return selectedToolCall(id, tool, 1)
        })()
      : [assistantMessage('归档验证的问题已经提出。')]
  response.end(createSse([responseCreated(id), ...items, responseCompleted(id)]))
  return true
}

/** Added to the CI-covered human-interactions checkpoint without another app startup. */
export async function verifyInteractionArchiving(control, timeoutMs, taskId) {
  // The preceding regression leaves the original task open and the inbox on history.
  for (const item of CASES) {
    await control.command('waitFor', COMPOSER, { visible: true })
    await control.command('fill', COMPOSER, { value: PREFIX + item.mode })
    await control.command(
      'waitFor',
      `${ORIGINAL} [data-testid="send-message-button"]:not(:disabled)`
    )
    await control.command('press', COMPOSER, { key: 'Enter' })
    await control.command('waitFor', `${ORIGINAL} [data-testid="request-user-input-card"]`, {
      text: item.question,
      timeoutMs,
    })
    await control.command('click', '[data-testid="workspace-tab-select-pending-interactions"]')
    await control.command('click', `${PAGE} [data-testid="interactions-history"]`)
    await control.command('waitFor', `${PAGE} [data-testid="interactions-pending-count"]`, {
      text: '1',
    })
    await control.command('waitFor', `${PAGE} [data-testid="interaction-source-group-task"]`, {
      text: item.question,
    })
    await control.command('waitFor', `${PAGE} [data-testid="interaction-list-item"]`, {
      text: item.question,
    })
    await control.command('click', `${PAGE} [data-testid="interaction-list-item"]`)
    if (item.mode === 'external') {
      await control.command('click', `${PAGE} [data-testid="interaction-open-original"]`)
      await control.command(
        'fill',
        `${ORIGINAL} [data-testid="request-user-input-custom-question_1"]`,
        {
          value: '已在原会话确认',
        }
      )
      const submit = `${ORIGINAL} [data-testid="request-user-input-submit-button"]:not(:disabled)`
      await control.command('waitFor', submit)
      await control.command('click', submit)
      await control.command('click', '[data-testid="workspace-tab-select-pending-interactions"]')
    } else {
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
        return transcript.messages
          .filter(message => message.role === 'user')
          .map(message => message.id)
      }
      const beforeDismiss = await readUserMessages()
      await control.command('hover', `${PAGE} [data-testid="interaction-list-item"]`)
      await control.command('click', `${PAGE} [data-testid="interaction-dismiss"]`)
      // Dismissal acquires cross-window locks before committing the archive.
      await control.command('waitFor', `${PAGE} [data-testid="interactions-pending-count"]`, {
        text: '0',
      })
      await control.command('click', `${PAGE} [data-testid="interactions-history"]`)
      await control.command('waitFor', `${PAGE} [data-testid="interaction-list-item"]`, {
        text: item.question,
      })
      await reloadMainWindow(control, 'The dismissed interaction must survive a renderer reload')
      assert.deepEqual(
        await readUserMessages(),
        beforeDismiss,
        'Dismissal must not send a runtime answer'
      )
    }
    await control.command('waitFor', `${PAGE} [data-testid="interactions-pending-count"]`, {
      text: '0',
    })
    await control.command('click', `${PAGE} [data-testid="interactions-history"]`)
    await control.command('waitFor', `${PAGE} [data-testid="interaction-list-item"]`, {
      text: item.question,
    })
    assert.equal(
      Number(
        await control.command('getElementCount', `${PAGE} [data-testid="interaction-dismiss"]`)
      ),
      0,
      'Handled history must not expose dismissal again'
    )
    if (item.mode === 'external') {
      await control.command('click', `${PAGE} [data-testid="interaction-open-original"]`)
    }
  }
}
