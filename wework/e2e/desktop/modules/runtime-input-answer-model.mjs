function isUserPrompt(item) {
  if (item?.role !== 'user') return false
  const content = typeof item.content === 'string' ? [{ text: item.content }] : item.content
  // Codex may append an environment delta after the prompt when the date changes.
  return (
    !Array.isArray(content) ||
    !content.length ||
    !content.every(part => {
      const text = part.text?.trim()
      return text?.startsWith('<environment_context>') && text.endsWith('</environment_context>')
    })
  )
}

export function lastUserMessageBody(body) {
  const input = Array.isArray(body.input) ? body.input : body.messages
  if (!Array.isArray(input)) return ''
  return JSON.stringify(input.findLast(isUserPrompt) ?? '')
}

export function currentTurnHasToolOutput(body, callId) {
  const input = Array.isArray(body.input) ? body.input : []
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (isUserPrompt(item)) return false
    if (
      ['function_call_output', 'custom_tool_call_output'].includes(item?.type) &&
      item.call_id === callId
    )
      return true
  }
  return false
}

export function currentTurnHasToolSearchResult(body, namespaceName) {
  const input = Array.isArray(body.input) ? body.input : []
  let turnStart = 0
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isUserPrompt(input[index])) {
      turnStart = index + 1
      break
    }
  }
  return input.slice(turnStart).some(item => JSON.stringify(item).includes(namespaceName))
}
