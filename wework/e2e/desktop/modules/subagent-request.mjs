const COLLABORATION_SUBAGENT_HEADER = 'collab_spawn'

function isCollaborationSubagentRequest(headers) {
  return headers['x-openai-subagent'] === COLLABORATION_SUBAGENT_HEADER
}

export { COLLABORATION_SUBAGENT_HEADER, isCollaborationSubagentRequest }
