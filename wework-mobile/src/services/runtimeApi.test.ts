import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('expo-file-system', () => ({
  File: class MockFile {
    exists = true
  },
}))

import { RuntimeApi, RuntimeApiError } from './runtimeApi'

const config = {
  backendUrl: 'https://wegent.example',
  apiBaseUrl: 'https://wegent.example/api/v1',
  socketBaseUrl: 'https://wegent.example',
  socketPath: '/socket.io',
  accessToken: 'secret-token',
}

describe('RuntimeApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads runtime work with bearer authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ projects: [], chats: [], totalTasks: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await new RuntimeApi(config).listWork()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://wegent.example/api/v1/runtime-work',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
        }),
      })
    )
  })

  it('loads the Wework model catalog including execution configuration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await new RuntimeApi(config).listModels()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://wegent.example/api/v1/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      })
    )
  })

  it('creates a chat using its prepared workspace path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: true,
          deviceId: 'cloud-1',
          taskId: 'task-1',
          workspacePath: '/runtime/chat/task-1',
          runtime: 'codex',
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    await new RuntimeApi(config).createConversation({
      schemaVersion: 2,
      deviceId: 'cloud-1',
      workspacePath: '/Users/me/Documents/Codex/2026-08-31/new-chat-12345678',
      taskId: 'task-1',
      runtime: 'codex',
      message: '你好',
      clientUserMessageId: 'message-1',
      title: '你好',
      modelId: 'wework-gpt-5.6-sol',
      modelType: 'public',
      modelOptions: { reasoning: 'high' },
    })

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(request.body))
    expect(body.workspacePath).toBe('/Users/me/Documents/Codex/2026-08-31/new-chat-12345678')
    expect(body).not.toHaveProperty('standaloneChatWorkspace')
  })

  it('prepares a standalone conversation workspace through device commands', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, stdout: '/Users/me\n' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, stdout: '' }), { status: 200 })
      )
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi(config)

    await expect(api.getHomeDirectory('cloud/1')).resolves.toBe('/Users/me')
    await api.createDirectory('cloud/1', '/Users/me/Documents/Codex/chat')

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://wegent.example/api/v1/devices/cloud%2F1/commands',
      'https://wegent.example/api/v1/devices/cloud%2F1/commands',
    ])
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      command_key: 'home_dir',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      command_key: 'mkdir_p',
      args: ['/Users/me/Documents/Codex/chat'],
      timeout_seconds: 15,
      max_output_bytes: 4096,
    })
  })

  it('sends the canonical runtime address when continuing a conversation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, taskId: 'task-1' }), {
        status: 200,
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await new RuntimeApi(config).sendMessage(
      { deviceId: 'cloud-1', taskId: 'task-1', workspacePath: '/work' },
      '继续',
      'message-1',
      {
        modelName: 'wework-gpt-5.6-sol',
        modelType: 'public',
        options: { reasoning: 'high' },
      }
    )

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({
      address: {
        deviceId: 'cloud-1',
        taskId: 'task-1',
        workspacePath: '/work',
      },
      message: '继续',
      clientUserMessageId: 'message-1',
      modelSelection: {
        modelName: 'wework-gpt-5.6-sol',
        modelType: 'public',
        options: { reasoning: 'high' },
      },
    })
  })

  it('sends uploaded attachment ids through the existing runtime endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ accepted: true, taskId: 'task-1' }), { status: 200 })
      )
    vi.stubGlobal('fetch', fetchMock)

    await new RuntimeApi(config).sendMessage(
      { deviceId: 'cloud-1', taskId: 'task-1' },
      '检查附件',
      'message-1',
      {
        modelName: 'wework-gpt-5.6-sol',
        modelType: 'public',
        options: { collaborationMode: 'plan' },
      },
      [41, 42]
    )

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      attachmentIds: [41, 42],
      modelSelection: { options: { collaborationMode: 'plan' } },
    })
  })

  it('cancels the current runtime task through the Wework endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, taskId: 'task-1', workspacePath: '/work' }), {
        status: 200,
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      new RuntimeApi(config).cancelTask({
        deviceId: 'cloud-1',
        taskId: 'task-1',
        workspacePath: '/work',
      })
    ).resolves.toEqual({ accepted: true, taskId: 'task-1', workspacePath: '/work' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://wegent.example/api/v1/runtime-work/cancel',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          deviceId: 'cloud-1',
          taskId: 'task-1',
          workspacePath: '/work',
        }),
      })
    )
  })

  it('uploads a native file as multipart without constructing a URI FormData part', async () => {
    const uploadFile = vi.fn().mockResolvedValue({
      body: JSON.stringify({
        id: 41,
        filename: 'photo.jpg',
        file_size: 2048,
        mime_type: 'image/jpeg',
      }),
      status: 200,
    })

    const attachment = await new RuntimeApi(config, uploadFile).uploadAttachment({
      uri: 'file:///cache/photo.jpg',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 2048,
    })

    expect(uploadFile).toHaveBeenCalledWith({
      url: 'https://wegent.example/api/v1/attachments/upload',
      uri: 'file:///cache/photo.jpg',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer secret-token',
      },
    })
    expect(attachment).toEqual({
      id: 41,
      filename: 'photo.jpg',
      fileSize: 2048,
      mimeType: 'image/jpeg',
    })
  })

  it('preserves a nested backend attachment error', async () => {
    const uploadFile = vi.fn().mockResolvedValue({
      body: JSON.stringify({
        detail: { message: 'Unsupported file type: .heic', error_code: 'unsupported_file_type' },
      }),
      status: 400,
    })

    await expect(
      new RuntimeApi(config, uploadFile).uploadAttachment({
        uri: 'file:///cache/photo.heic',
        name: 'photo.heic',
        mimeType: 'image/heic',
        size: 2048,
      })
    ).rejects.toEqual(
      new RuntimeApiError('Unsupported file type: .heic', 400, {
        detail: { message: 'Unsupported file type: .heic', error_code: 'unsupported_file_type' },
      })
    )
  })

  it('creates a persistent goal through the runtime goal endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await new RuntimeApi(config).setGoal(
      { deviceId: 'cloud-1', taskId: 'task-1' },
      '持续完成移动端'
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://wegent.example/api/v1/runtime-work/goal/set',
      expect.objectContaining({ method: 'POST' })
    )
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
    expect(body).toEqual({
      address: { deviceId: 'cloud-1', taskId: 'task-1' },
      objective: '持续完成移动端',
      status: 'active',
    })
  })

  it('preserves backend error details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'executor offline' }), {
          status: 502,
        })
      )
    )

    await expect(new RuntimeApi(config).listWork()).rejects.toEqual(
      new RuntimeApiError('executor offline', 502, {
        detail: 'executor offline',
      })
    )
  })
})
