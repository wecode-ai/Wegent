import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { modelRequestTexts, readPreparedQuestionAttachmentPath } from './model-tool-output.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from './shared.mjs'
import {
  assistantMessage,
  requestContainsToolOutput,
  selectedToolCall,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'

export const ANSWER_EDITOR_PROMPT = 'WEWORK_QUESTION_ANSWER_EDITOR'
const FILE = 'question-editor-brief.txt'
const CONTENT = 'WEWORK_QUESTION_FILE_BYTES'
const ANSWER = 'First line\nSecond line'
const CARD = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`
const INPUT = `${CARD} [data-testid="request-user-input-custom-question_1"]`
const ANSWER_ROW = `${CARD} [data-testid="request-user-input-answer-row-question_1"]`
const DONE = 'WEWORK_QUESTION_EDITOR_SKIPPED'
const READY = 'WEWORK_QUESTION_EDITOR_OPTIONAL_READY'
const MANUAL_REPLY = 'WEWORK_QUESTION_EDITOR_MANUAL_REPLY'

async function verifySingleLineAnswerLayout(control, empty) {
  const lineHeight = Number.parseFloat(
    await control.command('getComputedStyleValue', INPUT, { value: 'line-height' })
  )
  const [editor] = JSON.parse(await control.command('getElementMetrics', INPUT))
  const [icon] = JSON.parse(await control.command('getElementMetrics', `${ANSWER_ROW} > span`))
  assert.ok(
    Number.isFinite(lineHeight) && lineHeight > 0,
    'The question editor must have a measurable line height'
  )
  assert.ok(
    Math.abs(editor.height - lineHeight) <= 1,
    `One-line editor height must equal one text line: ${JSON.stringify({ editor, lineHeight })}`
  )
  const center = rect => (rect.top + rect.bottom) / 2
  assert.ok(
    Math.abs(center(editor) - center(icon)) <= 1,
    'The one-line answer and pencil must share their vertical center'
  )
  if (empty) {
    const [placeholder] = JSON.parse(
      await control.command('getElementMetrics', `${ANSWER_ROW} .composer-prosemirror-placeholder`)
    )
    assert.ok(
      Math.abs(placeholder.height - lineHeight) <= 1 &&
        Math.abs(center(placeholder) - center(icon)) <= 1,
      'The empty placeholder must occupy one centered text line'
    )
  }
  return lineHeight
}

function strings(value) {
  if (typeof value === 'string') return value
  return Object.values(value ?? {})
    .map(strings)
    .join('\n')
}

/** Model-only fixtures; clipboard, saved files, execution and answer routing stay real. */
export function createQuestionAnswerEditorRegression({ workspacePath }) {
  let readFile = false
  let modelRequests = 0
  return {
    respond(body) {
      const text = strings(body.input ?? body.messages)
      if (!text.includes(ANSWER_EDITOR_PROMPT)) return undefined
      modelRequests += 1
      if (!requestContainsToolOutput(body, 'answer-editor-question'))
        return selectedToolCall(
          'answer-editor-question',
          selectTool(body, 'request_user_input_async', {
            questions: [{ title: 'Provide a multiline answer and the brief file.' }],
          })
        )
      const groupedReply = modelRequestTexts(body, 'user').match(
        /^Question answers:\n(\{[\s\S]*?\n\})/m
      )?.[1]
      const answers = groupedReply ? (JSON.parse(groupedReply).question_1?.answers ?? []) : []
      if (!answers.includes(ANSWER)) return [assistantMessage('Waiting for the answer and file.')]
      if (!requestContainsToolOutput(body, 'answer-editor-read')) {
        const path = readPreparedQuestionAttachmentPath(answers, FILE)
        const quoted =
          process.platform === 'win32'
            ? `'${path.replaceAll("'", "''")}'`
            : `'${path.replaceAll("'", "'\\''")}'`
        return selectedToolCall(
          'answer-editor-read',
          selectTool(body, 'exec_command', {
            cmd: `node -e "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))" ${quoted}`,
            max_output_tokens: 200,
          })
        )
      }
      assert.ok(
        toolOutputText(body, 'answer-editor-read')?.includes(CONTENT),
        'The executor must read the pasted file bytes successfully'
      )
      readFile = true
      if (!requestContainsToolOutput(body, 'answer-editor-skip'))
        return selectedToolCall(
          'answer-editor-skip',
          selectTool(body, 'request_user_input_async', {
            questions: [{ title: 'You may skip this optional follow-up.' }],
          })
        )
      const userMessages = (body.input ?? []).filter(message => message.role === 'user')
      assert.ok(
        !strings(userMessages).includes('Do not send this draft'),
        'Skip must not send the custom draft'
      )
      assert.ok(
        !userMessages.some(message => strings(message).trim().endsWith('继续')),
        'Skip must not send a synthetic continuation message'
      )
      return [assistantMessage(text.includes(MANUAL_REPLY) ? DONE : READY)]
    },
    async verify(control) {
      await control.command('click', '[data-testid="new-chat-button"]')
      const workspace = join(workspacePath, 'question-answer-editor')
      await mkdir(workspace, { recursive: true })
      await createSingleRootLocalProject(control, workspace, 'Question answer editor')
      await selectE2EModel(control)
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: ANSWER_EDITOR_PROMPT })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command('waitFor', CARD, { text: 'Provide a multiline answer', visible: true })
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: 'Waiting for the answer and file.' }
      )
      const lineHeight = await verifySingleLineAnswerLayout(control, true)
      await control.command('fill', INPUT, { value: 'First line' })
      await verifySingleLineAnswerLayout(control, false)
      await control.command('press', INPUT, { key: 'Shift+Enter' })
      assert.equal(await control.command('getValue', INPUT), 'First line\n')
      const [multiline] = JSON.parse(await control.command('getElementMetrics', INPUT))
      assert.ok(
        multiline.height >= 2 * lineHeight - 1,
        'A newline must grow the answer to two text lines'
      )
      await control.command('pasteText', INPUT, { value: 'Second line' })
      await control.command('pasteFile', INPUT, {
        filename: FILE,
        mimeType: 'text/plain',
        value: Buffer.from(CONTENT).toString('base64'),
      })
      await control.command('waitFor', `${CARD} [data-testid="attachment-badge"]`, { text: FILE })
      await control.command('click', `${CARD} [data-testid="request-user-input-ignore-button"]`)
      await control.command(
        'click',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-expand"]`
      )
      assert.equal(
        await control.command('getValue', INPUT),
        ANSWER,
        'Collapse must retain multiline drafts'
      )
      await control.command('waitFor', `${CARD} [data-testid="attachment-badge"]`, { text: FILE })
      await control.command(
        'clickWhenEnabled',
        `${CARD} [data-testid="request-user-input-submit-button"]`
      )
      await control.command('waitFor', CARD, { text: 'optional follow-up', visible: true })
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: READY }
      )
      const beforeSkip = modelRequests
      const userSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`
      const userCount = await control.command('getElementCount', userSelector)
      await control.command('fill', INPUT, { value: 'Do not send this draft' })
      await control.command(
        'clickWhenEnabled',
        `${CARD} [data-testid="request-user-input-skip-button"]`
      )
      // Observe a negative window before manually continuing the conversation.
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, { visible: true, stableMs: 2000 })
      assert.equal(await control.command('getElementCount', userSelector), userCount)
      assert.equal(modelRequests, beforeSkip, 'Skip must not request another model turn')
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: MANUAL_REPLY })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        { text: DONE }
      )
      assert.ok(readFile)
    },
  }
}
