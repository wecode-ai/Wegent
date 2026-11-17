import assert from 'node:assert/strict'
import {
  assistantMessage,
  mcpToolRequestEvents,
  requestContainsToolOutput,
} from './response-protocol.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'

const PREFIX = 'WEWORK_IM_QUESTION_'

// Native additional context can be a JSON value or JSON embedded in a text item.
function embeddedObjects(text) {
  const values = []
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let quoted = false
    for (let end = start; end < text.length; end++) {
      const character = text[end]
      if (quoted && character === '\\') {
        end++
        continue
      }
      if (character === '"') quoted = !quoted
      if (quoted) continue
      if (character === '{') depth++
      if (character === '}' && --depth === 0) {
        try {
          values.push(JSON.parse(text.slice(start, end + 1)))
        } catch {
          /* Other model text is not context. */
        }
        break
      }
    }
  }
  return values
}

function pendingContexts(body) {
  const found = []
  const visit = value => {
    if (typeof value === 'string') {
      for (const object of embeddedObjects(value)) visit(object)
    } else if (value && typeof value === 'object') {
      if (value.replyToken && Array.isArray(value.questions)) found.push(value)
      for (const child of Object.values(value)) visit(child)
    }
  }
  visit(body.input)
  return found
}

export function interpretedImReplyEvents(body) {
  const latest = (Array.isArray(body.input) ? body.input : [])
    .filter(item => item.role === 'user')
    .at(-1)
  const text =
    typeof latest?.content === 'string'
      ? latest.content
      : (latest?.content ?? []).map(part => part.text ?? '').join('\n')
  const match = text.match(/WEWORK_IM_QUESTION_(chat|interpret)_(inferred-(?:sync|async))/)
  if (!match) return null
  const [, action, mode] = match
  if (action === 'chat') return [assistantMessage(`${PREFIX}chat_${mode}_complete`)]
  const call = `${PREFIX}interpret_${mode}_call`
  if (requestContainsToolOutput(body, call)) {
    const result = JSON.parse(readMcpToolOutput(body, call))
    assert.equal(result.recorded, true)
    assert.equal(result.taskCompleted, false)
    return [assistantMessage(`${PREFIX}interpreted_${mode}`)]
  }
  const context = pendingContexts(body).at(-1)
  assert.ok(context, 'The actual stand-in model must receive pending IM question context')
  const question = context.questions.find(item =>
    item.question.includes(`${PREFIX}${mode}_question`)
  )
  assert.ok(question, 'The current private IM context must contain the original question')
  return mcpToolRequestEvents(body, {
    toolName: 'answer_im_question',
    directToolName: 'mcp__wework_stand_in__answer_im_question',
    argumentsValue: {
      replyToken: context.replyToken,
      questionId: question.questionId,
      answer: `${PREFIX}${mode}_answer`,
    },
    searchCallId: `${call}_search`,
    toolCallId: call,
  }).events
}
