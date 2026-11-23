const COLLABORATION_SUBAGENT_HEADER = 'collab_spawn'

function isCollaborationSubagentRequest(headers) {
  return headers['x-openai-subagent'] === COLLABORATION_SUBAGENT_HEADER
}

function nativeSubagentCompletionPayload(request, sender) {
  // The Responses proxy can forward the native V2 envelope as a developer message.
  const parent = sender.slice(0, sender.lastIndexOf('/'))
  const prefix = `Message Type: FINAL_ANSWER\nTask name: ${parent}\nSender: ${sender}\nPayload:\n`
  for (const item of request.input ?? []) {
    const isAgentMessage =
      item.type === 'agent_message' && item.author === sender && item.recipient === parent
    if (!isAgentMessage && !(item.type === 'message' && item.role === 'developer')) continue
    const content =
      typeof item.content === 'string'
        ? item.content
        : (item.content ?? []).map(part => part.text ?? '').join('')
    if (content.startsWith(prefix)) return content.slice(prefix.length)
  }
  return undefined
}

export {
  COLLABORATION_SUBAGENT_HEADER,
  isCollaborationSubagentRequest,
  nativeSubagentCompletionPayload,
}
