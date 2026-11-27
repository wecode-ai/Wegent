import { modelApplicationContextText } from './application-context-model.mjs'
import assert from 'node:assert/strict'
import { selectedToolCall } from './model-tool-calls.mjs'
import { selectMcpToolRequest, toolSearchResponseEvents } from './response-protocol.mjs'

// Script only the model: discover and read the real native conversation capability.
export function conversationReferenceReadEvents(request, callId) {
  const reference = modelApplicationContextText(request, 'referencedConversations')
  const id = reference.match(/"conversation_id"\s*:\s*"(conv_[A-Za-z0-9_-]+)"/)?.[1]
  assert.ok(id, 'The submission must contain a native conversation reference')
  const selection = selectMcpToolRequest(
    request,
    'read_conversation',
    { conversation_id: id, limit: 50 },
    'mcp__wework_control__read_conversation'
  )
  if (selection.mode === 'search') return toolSearchResponseEvents(`${callId}-search`, selection)
  if (selection.codeMode) {
    const input = [
      `const result = await tools[${JSON.stringify(selection.codeMode.targetName)}](${JSON.stringify(selection.arguments)})`,
      'if (result.isError) throw new Error(JSON.stringify(result.content))',
      'const page = result.structuredContent ?? JSON.parse(result.content.find(part => part.type === "text").text)',
      'if (!Array.isArray(page.messages)) throw new Error("Missing native conversation messages")',
      // The model needs visible prose, not the large command output exercised by this scenario.
      'text({ messages: page.messages.filter(message => message.role === "user" || (message.role === "assistant" && message.status === "done")).map(({ role, content }) => ({ role, content })), page: page.page })',
    ].join('\n')
    selection.codeMode = { ...selection.codeMode, targetName: undefined, input }
  }
  return selectedToolCall(callId, selection)
}
