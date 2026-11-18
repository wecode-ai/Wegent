import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { expect } from '@playwright/test'
import { test } from '../../fixtures/task-runtime'
import { checked } from '../../fixtures/recent-team-history'
import { createApiClient } from '../../utils/api-client'
import { waitForTaskTerminal } from '../../utils/provider-native-test-support'
import type { VisionMessage } from '../../utils/mock-model-vision'
import { scopedMockUrl } from '../../utils/mock-scope'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'

test.describe('Chat Image E2E with Mock Model Server', () => {
  test('should send image_url to model when image is attached', async ({ runtimeAccount }) => {
    const { token, request } = runtimeAccount
    const api = createApiClient(request, API_BASE_URL, token)
    const prefix = `e2e-image-${randomUUID()}`
    const mockUrl = scopedMockUrl(
      process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999',
      prefix
    )
    const modelName = `${prefix}-model`
    const teamName = `${prefix}-team`
    const prompt = `What is in this image? ${prefix}`
    const cleanupPaths: string[] = []
    let originalFailure: unknown
    const client = createAuthenticatedSocketClient({
      socketBaseUrl: () => API_BASE_URL,
      getToken: () => token,
      namespace: '/chat',
    })
    try {
      const health = await request.get(`${mockUrl}/health`)
      expect(health.ok()).toBe(true)
      checked(
        await api.post('/api/v1/namespaces/default/models', {
          kind: 'Model',
          metadata: { name: modelName, namespace: 'default' },
          spec: {
            modelType: 'llm',
            modelCapabilities: { supportsImage: true },
            modelConfig: {
              env: {
                model: 'openai',
                model_id: 'mock-vision-model',
                api_key: 'mock-api-key',
                base_url: `${mockUrl}/v1`,
              },
            },
          },
        }),
        201
      )
      cleanupPaths.push(`/api/v1/namespaces/default/models/${modelName}`)
      const bot = checked(
        await api.post<{ id: number }>('/api/bots', {
          name: `${prefix}-bot`,
          shell_name: 'Chat',
          namespace: 'default',
          agent_config: { bind_model: modelName, bind_model_type: 'user' },
          system_prompt: 'Describe the image directly without tools.',
        }),
        201
      )
      cleanupPaths.push(`/api/bots/${bot.id}`)
      const team = checked(
        await api.createTeam({
          name: teamName,
          namespace: 'default',
          bots: [{ bot_id: bot.id, role: 'worker', bot_prompt: '' }],
          bind_mode: ['chat'],
          requires_workspace: false,
        }),
        201
      ) as { id: number }
      cleanupPaths.push(`/api/v1/namespaces/default/teams/${teamName}`)
      const image = readFileSync(path.join(__dirname, '../../fixtures/test-image.png'))
      const uploaded = await request.post(`${API_BASE_URL}/api/attachments/upload`, {
        headers: { Authorization: `Bearer ${token}` },
        multipart: { file: { name: 'test-image.png', mimeType: 'image/png', buffer: image } },
      })
      expect(uploaded.status()).toBe(200)
      const attachment = (await uploaded.json()) as { id: number }
      expect(attachment.id).toBeGreaterThan(0)
      await client.ensureConnected()
      const ack = (await client
        .getRawSocket()!
        .timeout(10_000)
        .emitWithAck('chat:send', {
          team_id: team.id,
          task_type: 'chat',
          message: prompt,
          attachment_ids: [attachment.id],
        })) as { task_id?: number; error?: string }
      expect(ack.error).toBeUndefined()
      expect(ack.task_id).toEqual(expect.any(Number))
      cleanupPaths.push(`/api/tasks/${ack.task_id}`)
      await waitForTaskTerminal(token, ack.task_id!)
      const captured = await request.get(`${mockUrl}/captured-requests`)
      expect(captured.status()).toBe(200)
      const calls = (await captured.json()) as Array<{
        url: string
        body: { messages: VisionMessage[] }
      }>
      const message = calls
        .filter(call => call.url.includes('/chat/completions'))
        .flatMap(call => call.body.messages)
        .find(
          message =>
            message.role === 'user' &&
            Array.isArray(message.content) &&
            message.content.some(part => part.type === 'text' && part.text?.includes(prompt))
        )
      expect(message).toBeDefined()
      expect(Array.isArray(message?.content)).toBe(true)
      if (!Array.isArray(message?.content)) throw new Error('Missing vision content')
      expect(message.content.find(part => part.type === 'text')?.text).toContain(prompt)
      const imagePart = message.content.find(part => part.type === 'image_url')
      expect(imagePart?.image_url?.url).toMatch(/^data:image\/png;base64,/)
    } catch (error) {
      originalFailure = error
      throw error
    } finally {
      client.dispose()
      const errors: unknown[] = []
      for (const resource of cleanupPaths.reverse()) {
        try {
          checked(await api.delete(resource))
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) {
        if (originalFailure !== undefined) errors.unshift(originalFailure)
        throw new AggregateError(errors, 'Image fixture cleanup failed')
      }
    }
  })
})
