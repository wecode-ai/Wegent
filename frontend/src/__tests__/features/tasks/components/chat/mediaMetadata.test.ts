// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  parseMp4VideoFrameRate,
  readVideoFrameRate,
} from '@/features/tasks/components/chat/mediaMetadata'

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payload = concatBytes(payloads)
  const result = new Uint8Array(8 + payload.length)
  const view = new DataView(result.buffer)
  view.setUint32(0, result.length)
  writeAscii(view, 4, type)
  result.set(payload, 8)
  return result
}

describe('parseMp4VideoFrameRate', () => {
  it('reads FPS from the MP4 video track timing table', () => {
    const mdhdPayload = new Uint8Array(24)
    const mdhdView = new DataView(mdhdPayload.buffer)
    mdhdView.setUint32(12, 24000)
    mdhdView.setUint32(16, 48000)

    const hdlrPayload = new Uint8Array(12)
    writeAscii(new DataView(hdlrPayload.buffer), 8, 'vide')

    const sttsPayload = new Uint8Array(16)
    const sttsView = new DataView(sttsPayload.buffer)
    sttsView.setUint32(4, 1)
    sttsView.setUint32(8, 48)
    sttsView.setUint32(12, 1000)

    const file = box(
      'moov',
      box(
        'trak',
        box(
          'mdia',
          box('mdhd', mdhdPayload),
          box('hdlr', hdlrPayload),
          box('minf', box('stbl', box('stts', sttsPayload)))
        )
      )
    )
    const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)

    expect(parseMp4VideoFrameRate(buffer as ArrayBuffer)).toBe(24)
  })

  it('returns null when the file has no readable video timing table', () => {
    expect(parseMp4VideoFrameRate(box('moov').buffer as ArrayBuffer)).toBeNull()
  })
})

describe('readVideoFrameRate', () => {
  it('reads bounded head and tail slices for large videos', async () => {
    const moov = box('moov')
    const slice = jest
      .fn()
      .mockReturnValueOnce({ arrayBuffer: async () => new ArrayBuffer(8) })
      .mockReturnValueOnce({
        arrayBuffer: async () =>
          moov.buffer.slice(moov.byteOffset, moov.byteOffset + moov.byteLength),
      })
    const file = {
      name: 'large.mp4',
      size: 64 * 1024 * 1024,
      slice,
    } as unknown as File

    await readVideoFrameRate(file)

    expect(slice).toHaveBeenCalledTimes(2)
    expect(slice.mock.calls[0]).toEqual([0, 16 * 1024 * 1024])
    expect(slice.mock.calls[1]).toEqual([48 * 1024 * 1024])
  })
})
