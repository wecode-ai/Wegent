import { gzipSync, strToU8 } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeMobileTranscriptGzip } from './mobileTranscriptTransfer'
import { RuntimeApi } from './runtimeApi'

const config = {
  apiBaseUrl: 'https://example.com/api',
  backendUrl: 'https://example.com',
  socketBaseUrl: 'https://example.com',
  socketPath: '/socket.io',
  accessToken: 'test-token',
}
const address = {
  deviceId: 'cloud-owner',
  taskId: 'parent',
  threadId: 'parent-thread',
  runtime: 'codex',
  workspacePath: '/worktrees/parent',
  runtimeHandle: { threadId: 'parent-thread' },
}
const transcript = (threadId = 'child-thread') => ({
  taskId: 'parent',
  threadId,
  runtime: 'codex',
  workspacePath: address.workspacePath,
  messages: [],
  runtimeTurns: [],
  turns: [
    {
      id: 'child-turn',
      status: 'completed',
      items: [{ id: 'reply', type: 'assistant_text', content: '子代理完成 🙂' }],
    },
  ],
})
afterEach(() => vi.unstubAllGlobals())

describe('isolated Mobile subagent transcript', () => {
  it('preserves parent routing and reads exactly the selected thread using the PC v2 protocol', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(transcript())))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const result = await new RuntimeApi(config).getSubagentTranscript(
      address,
      'child-thread',
      controller.signal
    )
    expect(result.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: '子代理完成 🙂' }),
    ])
    expect(result.threadId).toBe('child-thread')
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${config.apiBaseUrl}/runtime-work/transcript`,
      expect.objectContaining({
        signal: controller.signal,
        method: 'POST',
        body: JSON.stringify({
          ...address,
          threadId: 'child-thread',
          includeFullContent: true,
          transcriptProtocolVersion: 2,
        }),
      })
    )
    expect(address.threadId).toBe('parent-thread')
  })

  it('restores Unicode from native gzip chunks with every subsequent request scoped to the same child', async () => {
    const bytes = gzipSync(
      strToU8(JSON.stringify({ transcript: transcript(), strings: [], references: [] }))
    )
    const snapshotId = 'a'.repeat(64)
    const split = Math.floor(bytes.length / 2)
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const query = JSON.parse(init.body as string)
      const offset = query.transcriptTransfer?.offset ?? 0
      const end = offset === 0 ? split : bytes.length
      return new Response(
        JSON.stringify({
          success: true,
          transcriptProtocolVersion: 2,
          transfer: {
            snapshotId,
            offset,
            totalBytes: bytes.length,
            encoding: 'gzip+base64+json',
            nextOffset: end === bytes.length ? null : end,
            payload: btoa(String.fromCharCode(...bytes.subarray(offset, end))),
          },
        })
      )
    })
    vi.stubGlobal('fetch', fetch)
    const result = await new RuntimeApi(config).getSubagentTranscript(address, 'child-thread')
    expect(result.messages[0]?.content).toBe('子代理完成 🙂')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string)).toEqual({
      ...address,
      threadId: 'child-thread',
      includeFullContent: true,
      transcriptProtocolVersion: 2,
      transcriptTransfer: { snapshotId, offset: split },
    })
  })

  it.each([
    [transcript('parent-thread'), 'different thread'],
    [{ ...transcript(), turns: undefined }, 'canonical turns'],
  ])('rejects a wrong thread or incomplete canonical response', async (body, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))))
    await expect(
      new RuntimeApi(config).getSubagentTranscript(address, 'child-thread')
    ).rejects.toThrow(message)
  })

  it('does not issue cancelled reads or publish a late result after cancellation', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    controller.abort()
    const api = new RuntimeApi(config)
    await expect(
      api.getSubagentTranscript(address, 'child-thread', controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
    let finish!: (response: Response) => void
    fetch.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const next = new AbortController()
    const read = api.getSubagentTranscript(address, 'child-thread', next.signal)
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    next.abort()
    finish(new Response(JSON.stringify(transcript())))
    await rejected
  })
})

describe('native gzip integrity', () => {
  it.each(['crc', 'length', 'truncated'] as const)(
    'rejects a %s corruption before returning content',
    async fault => {
      const bytes = gzipSync(strToU8('complete transcript 中文'))
      if (fault === 'crc') bytes[bytes.length - 8]! ^= 1
      if (fault === 'length') bytes[bytes.length - 4]! ^= 1
      await expect(
        decodeMobileTranscriptGzip([
          fault === 'truncated' ? bytes.subarray(0, bytes.length - 3) : bytes,
        ])
      ).rejects.toThrow()
    }
  )
})
