import { createStandInImConnectionsStory } from '../modules/stand-in-im-connections.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

export function createDesktopScenario(options) {
  return {
    requiresCloudEnvironment: true,
    requiresRemoteExecutor: false,
    ...createStandInImConnectionsStory(options),
    async handleHttp(request, response, url) {
      if (
        request.method !== 'POST' ||
        !['/responses', '/v1/responses', '/backend-api/codex/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      const input = JSON.stringify(body.input ?? [])
      const role = input.includes('请按评审分身的职责')
      if (!role && !input.includes('我希望日报先列重点')) return false
      const id = `im-stand-in-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(
            role
              ? '我会检查消息归属、绑定保存和失败恢复。'
              : '已记住。后续日报会先列重点，再列待确认事项。'
          ),
          responseCompleted(id),
        ])
      )
      return true
    },
  }
}
