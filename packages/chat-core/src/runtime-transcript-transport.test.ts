import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { readRuntimeTranscript } from './runtime-transcript-transport'

const address = { taskId: 'task-1', threadId: 'thread-1', deviceId: 'device-1', refresh: true }
const chunkSize = 360 * 1024

function fixture(transcript: unknown, strings: string[] = [], references: unknown[] = []) {
  const bytes = gzipSync(JSON.stringify({ transcript, strings, references }))
  const snapshotId = createHash('sha256').update(bytes).digest('hex')
  const packets = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) => {
    const offset = index * chunkSize
    const end = Math.min(offset + chunkSize, bytes.length)
    return {
      success: true,
      transcriptProtocolVersion: 2,
      transfer: {
        snapshotId,
        offset,
        totalBytes: bytes.length,
        encoding: 'gzip+base64+json',
        nextOffset: end < bytes.length ? end : null,
        payload: bytes.subarray(offset, end).toString('base64'),
      },
    }
  })
  return { packets, snapshotId }
}

describe('lossless transcript transfer', () => {
  it('opts in without requiring old executors to implement a new RPC', async () => {
    const transcript = { messages: [], turns: [], fullContent: false }
    const request = vi.fn().mockResolvedValue(transcript)
    expect(await readRuntimeTranscript(address, request)).toBe(transcript)
    expect(request).toHaveBeenCalledExactlyOnceWith({ ...address, transcriptProtocolVersion: 2 })
  })

  it('restores Unicode and structured tool output only after every snapshot chunk arrives', async () => {
    const text = Array.from(
      { length: 28_000 },
      (_, index) => createHash('sha256').update(String(index)).digest('hex') + '中文🙂\n'
    ).join('')
    const body = {
      messages: [{ content: null }],
      turns: [{ items: [{ tool_output: { content: null } }] }],
      beforeCursor: 'older',
      fullContent: true,
    }
    const { packets, snapshotId } = fixture(
      body,
      [text],
      [
        { path: ['messages', 0, 'content'], index: 0 },
        { path: ['turns', 0, 'items', 0, 'tool_output', 'content'], index: 0 },
      ]
    )
    expect(packets.length).toBeGreaterThan(1)
    let call = 0
    const request = vi.fn(async () => packets[call++])
    const result = await readRuntimeTranscript(address, request)
    expect(result).toEqual({
      ...body,
      messages: [{ content: text }],
      turns: [{ items: [{ tool_output: { content: text } }] }],
    })
    packets.forEach((packet, index) => {
      expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThan(512 * 1024)
      if (index)
        expect(request).toHaveBeenNthCalledWith(index + 1, {
          ...address,
          transcriptProtocolVersion: 2,
          transcriptTransfer: { snapshotId, offset: index * chunkSize },
        })
    })
  })

  it('does not accept missing, repeated, swapped, or incomplete chunks', async () => {
    await expect(readRuntimeTranscript(address, vi.fn().mockResolvedValue(null))).rejects.toThrow(
      'incomplete transcript'
    )
    const text = Array.from({ length: 15_000 }, (_, i) =>
      createHash('sha256').update(String(i)).digest('hex')
    ).join('')
    const { packets } = fixture({ messages: [{ content: text }], turns: [] })
    expect(packets.length).toBeGreaterThan(1)
    for (const patch of [
      { offset: 0 },
      { snapshotId: 'b'.repeat(64) },
      { totalBytes: 1 },
      { payload: '' },
    ]) {
      const request = vi
        .fn()
        .mockResolvedValueOnce(packets[0])
        .mockResolvedValueOnce({
          ...packets[1],
          transfer: { ...packets[1].transfer, ...patch },
        })
      await expect(readRuntimeTranscript(address, request)).rejects.toThrow('incomplete transcript')
    }
    await expect(
      readRuntimeTranscript(
        address,
        vi.fn().mockResolvedValue({
          ...packets[0],
          transfer: { ...packets[0].transfer, nextOffset: null },
        })
      )
    ).rejects.toThrow('incomplete transcript')
  })

  it('preserves expired snapshot and runtime errors instead of returning an empty chat', async () => {
    await expect(
      readRuntimeTranscript(
        address,
        vi.fn().mockResolvedValue({
          success: false,
          code: 'transcript_snapshot_expired',
          error: 'Reload history',
        })
      )
    ).rejects.toThrow('Reload history')
    await expect(
      readRuntimeTranscript(
        address,
        vi.fn().mockResolvedValue({
          success: false,
          code: 'runtime_rpc_response_too_large',
        })
      )
    ).rejects.toThrow('Upgrade the Executor')
    await expect(
      readRuntimeTranscript(
        address,
        vi.fn().mockResolvedValue({
          transcriptProtocolVersion: 3,
        })
      )
    ).rejects.toThrow('Unsupported transcript protocol')
  })

  it('rejects corrupt compressed data before publishing a page', async () => {
    const { packets } = fixture({ messages: [], turns: [] })
    const bytes = Buffer.from(packets[0].transfer.payload, 'base64')
    bytes[bytes.length - 5] ^= 255
    packets[0].transfer.payload = bytes.toString('base64')
    await expect(
      readRuntimeTranscript(address, vi.fn().mockResolvedValue(packets[0]))
    ).rejects.toThrow()
  })

  it('never follows inherited reference paths into prototypes', async () => {
    const { packets } = fixture({}, ['value'], [{ path: ['__proto__', 'injected'], index: 0 }])
    await expect(
      readRuntimeTranscript(address, vi.fn().mockResolvedValue(packets[0]))
    ).rejects.toThrow('incomplete transcript')
    expect(Object.prototype).not.toHaveProperty('injected')
    const ownKey = JSON.parse('{"__proto__":null}')
    const valid = fixture(ownKey, ['value'], [{ path: ['__proto__'], index: 0 }])
    expect(
      await readRuntimeTranscript(address, vi.fn().mockResolvedValue(valid.packets[0]))
    ).toEqual(JSON.parse('{"__proto__":"value"}'))
  })
})
