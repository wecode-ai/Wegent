import { describe, expect, it } from 'vitest'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'
import { projectReplyPrediction } from './projectReplyPrediction'
import { predictionPrompt } from './replyPredictionService'

function message(
  id: string,
  sender: 'user' | 'agent' | 'system',
  content: string,
  status: ProjectChatMessage['status'] = 'completed'
): ProjectChatMessage {
  return {
    messageId: id,
    sender: { type: sender, id: id, name: id },
    type: 'text',
    content,
    status,
    createdAt: id,
    updatedAt: id,
  } as ProjectChatMessage
}
describe('project discussion prediction source', () => {
  it('uses the discussion scope and ordered human/AI turns, ignoring status notifications', async () => {
    const source = projectReplyPrediction('issue:1:thread:2', [
      message('u1', 'user', '不能删除数据'),
      message('system', 'system', '状态已改变'),
      message('a1', 'agent', '可以先备份'),
      message('a2', 'agent', '然后再迁移'),
    ])
    expect(source.scope).toBe('issue:1:thread:2')
    expect(predictionPrompt(await source.load())).toContain('不能删除数据')
    expect((await source.load())[0].assistant).toBe('可以先备份\n然后再迁移')
    expect(predictionPrompt(await source.load())).not.toContain('状态已改变')
  })
  it('does not predict after an unanswered human message or failed AI response', async () => {
    expect(
      predictionPrompt(
        await projectReplyPrediction('issue:1', [message('u', 'user', '还有一个问题')]).load()
      )
    ).toBeNull()
    expect(
      predictionPrompt(
        await projectReplyPrediction('issue:1', [
          message('a', 'agent', '请求失败', 'failed'),
        ]).load()
      )
    ).toBeNull()
    expect(
      projectReplyPrediction('issue:1', [message('a', 'agent', '生成中', 'streaming')]).busy
    ).toBe(true)
  })
})
