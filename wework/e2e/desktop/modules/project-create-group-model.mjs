import assert from 'node:assert/strict'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

export const GROUP_DRAFT_REQUEST = 'PROJECT_CREATE_GROUP_DRAFT_E2E'
export const GENERATED_GROUP_NAME = '真实分工验收小组'

/** Only the upstream model is scripted; prompt construction and draft parsing remain real. */
export async function handleProjectCreateGroupModel(request, response, url) {
  if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
    return false
  const body = await readRequestBody(request)
  const messages = Array.isArray(body.input) ? body.input : []
  const prompt = messages
    .filter(message => message.role === 'user')
    .map(message =>
      typeof message.content === 'string'
        ? message.content
        : (message.content ?? []).map(part => part.text ?? '').join('\n')
    )
    .findLast(
      text =>
        text.includes(GROUP_DRAFT_REQUEST) &&
        text.includes('你是项目协作架构师。') &&
        /^协作者：\[/m.test(text)
    )
  if (!prompt) return false
  assert.ok(body.model, 'Group generation must reach the model with its selected identity')
  const participants = JSON.parse(prompt.match(/^协作者：(\[[^\n]+\])/m)[1])
  assert.ok(participants.length >= 3, 'The real prompt must include its owner and selected agents')
  assert.equal(
    new Set(participants.map(participant => `${participant.kind}:${participant.id}`)).size,
    participants.length
  )
  const events = [{ type: 'group', name: GENERATED_GROUP_NAME }]
  for (const [index, participant] of participants.entries()) {
    assert.ok(['human', 'agent'].includes(participant.kind) && participant.id && participant.name)
    events.push({
      type: 'participant_started',
      kind: participant.kind,
      id: String(participant.id),
      leader: index === 0,
    })
    for (const delta of [
      `${participant.name}负责根据真实需求梳理实施边界、逐项核对验收条件，并把发现的问题和依赖及时反馈给负责人。`.repeat(
        5
      ),
      '执行完成后提交可复现的验证步骤、实际结果、风险说明与交付位置，确保下一位协作者能够独立继续工作。'.repeat(
        5
      ),
    ])
      events.push({
        type: 'participant_delta',
        kind: participant.kind,
        id: String(participant.id),
        delta,
      })
  }
  events.push(
    { type: 'principle', text: '负责人拆解任务并统一验收，成员独立执行并提交证据。' },
    { type: 'principle', text: '阻塞先反馈影响和需要的决策，未确认前保留已有工作。' },
    { type: 'stage', id: 'requirements', name: '需求确认' },
    { type: 'stage', id: 'implementation', name: '实现与验证' },
    { type: 'stage', id: 'acceptance', name: '验收交付' }
  )
  const id = `project-create-group-${Date.now()}`
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(
    createSse([
      responseCreated(id),
      assistantMessage(JSON.stringify({ events })),
      responseCompleted(id),
    ])
  )
  return true
}
