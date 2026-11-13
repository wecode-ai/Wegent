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
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends blocking answers through the PC structured-response endpoint with scoped identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"accepted":true,"taskId":"task"}'))
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi(config)
    const address = { deviceId: 'device', taskId: 'task' }
    const response = {
      requestId: 0,
      itemId: 'item',
      interactionScope: 'turn',
      answers: { choice: { answers: ['One'] } },
    }
    await api.respondToUserInput(address, response)
    expect(fetchMock.mock.calls[0]![0]).toBe(`${config.apiBaseUrl}/runtime-work/send`)
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      address,
      message: 'One',
      requestUserInputResponse: response,
    })
  })

  it('guides an active async question without sending a blocking response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"accepted":true}'))
    vi.stubGlobal('fetch', fetchMock)
    const address = { deviceId: 'device', taskId: 'task' }
    await new RuntimeApi(config).guideTask(address, 'One', 'guidance')
    expect(fetchMock.mock.calls[0]![0]).toBe(`${config.apiBaseUrl}/runtime-work/guidance`)
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      address,
      message: 'One',
      clientGuidanceId: 'guidance',
    })
  })

  it('uses the latest access token without rebuilding its data scope', async () => {
    let token = 'before'
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{"items":[]}'))
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi(config, undefined, () => token)
    await api.listDevices()
    token = 'after'
    await api.listDevices()
    expect(fetchMock.mock.calls.map(call => call[1].headers.Authorization)).toEqual([
      'Bearer before',
      'Bearer after',
    ])
  })

  it('coalesces composer inventory reads, caches for 30 seconds, and isolates devices', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1)
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{"items":[]}'))
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi(config)
    const one = api.listInstalledPlugins('first')
    expect(api.listInstalledPlugins('first')).toBe(one)
    await one
    await api.listInstalledPlugins('first')
    expect(fetchMock).toHaveBeenCalledOnce()
    await api.listInstalledPlugins('second')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    now.mockReturnValue(30_002)
    await api.listInstalledPlugins('first')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    api.clearPluginCatalogs()
    await api.listInstalledPlugins('first')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('never caches failed inventory reads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"detail":"denied"}', { status: 403 }))
      .mockResolvedValueOnce(new Response('{"items":[]}'))
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi(config)
    await expect(api.listInstalledPlugins('first')).rejects.toThrow('denied')
    await expect(api.listInstalledPlugins('first')).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('recovers a rejected read only when its in-flight token has already been replaced', async () => {
    let token = 'expired'
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        token = 'fresh'
        return new Response('{}', { status: 401 })
      })
      .mockResolvedValueOnce(new Response('{"items":[]}'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new RuntimeApi(config, undefined, () => token).listDevices()).resolves.toEqual({
      items: [],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBe('Bearer fresh')
  })

  it('never repeats a rejected mutation or a read with an unchanged invalid token', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new RuntimeApi(config).listDevices()).rejects.toBeInstanceOf(RuntimeApiError)
    expect(fetchMock).toHaveBeenCalledOnce()
    let token = 'old'
    fetchMock.mockImplementation(async () => {
      token = 'new'
      return new Response('{}', { status: 401 })
    })
    await expect(
      new RuntimeApi(config, undefined, () => token).setGoal(
        { deviceId: 'device', taskId: 'task' },
        'goal'
      )
    ).rejects.toBeInstanceOf(RuntimeApiError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
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

  it('loads only the selected APP catalog through the existing authorized PC endpoint', async () => {
    const native = { runtime: 'codex', provider: 'openai', model_id: 'gpt-6.1-sol' }
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            { id: '11', models: [native], catalog_error: null },
            { id: '12', models: [{ ...native, model_id: 'other-device' }] },
          ])
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = new RuntimeApi({ ...config, apiBaseUrl: 'https://wegent.example/api' })

    await expect(api.listNativeModels(11)).resolves.toEqual({
      models: [native],
      catalog_error: null,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://wegent.example/api/v1/resources/execution-environments',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      })
    )
    await expect(api.listNativeModels(13)).rejects.toThrow('设备已不可用')
  })

  it('creates a standalone chat through the existing create endpoint without preparing a directory', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: true,
          deviceId: 'app-record-11',
          taskId: 'task',
          workspacePath: '/Users/owner/Documents/Codex/task',
          runtime: 'codex',
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      new RuntimeApi(config).createConversation({
        schemaVersion: 2,
        deviceId: 'app-record-11',
        taskId: 'task',
        runtime: 'codex',
        message: '你好',
        clientUserMessageId: 'message',
        title: '你好',
        modelId: 'public-model',
        modelType: 'public',
        modelOptions: {},
        standaloneChatWorkspace: true,
      })
    ).resolves.toMatchObject({ accepted: true, workspacePath: '/Users/owner/Documents/Codex/task' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, request] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://wegent.example/api/v1/runtime-work/create')
    expect(request.method).toBe('POST')
    expect(JSON.parse(request.body)).toMatchObject({
      deviceId: 'app-record-11',
      standaloneChatWorkspace: true,
    })
    expect(JSON.parse(request.body)).not.toHaveProperty('workspacePath')
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

  it('reads the home directory and creates project directories on a cloud device', async () => {
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

    await expect(new RuntimeApi(config).listDevices()).rejects.toEqual(
      new RuntimeApiError('executor offline', 502, {
        detail: 'executor offline',
      })
    )
  })
})
