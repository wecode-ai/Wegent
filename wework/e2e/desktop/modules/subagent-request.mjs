const COLLABORATION_SUBAGENT_HEADER = 'collab_spawn'

function isCollaborationSubagentRequest(headers) {
  return headers['x-openai-subagent'] === COLLABORATION_SUBAGENT_HEADER
}

function nativeSubagentCompletionPayload(request, sender) {
  // Native V2 completion messages are distinct from user input and tool prompts.
  const parent = sender.slice(0, sender.lastIndexOf('/'))
  const prefix = `Message Type: FINAL_ANSWER\nTask name: ${parent}\nSender: ${sender}\nPayload:\n`
  for (const item of request.input ?? []) {
    if (item.type !== 'agent_message' || item.author !== sender || item.recipient !== parent)
      continue
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
