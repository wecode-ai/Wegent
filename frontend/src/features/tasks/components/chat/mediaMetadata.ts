// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

function readAscii(view: DataView, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index))
  }
  return value
}

function readUint64(view: DataView, offset: number): number {
  const high = view.getUint32(offset)
  const low = view.getUint32(offset + 4)
  if (high > Math.floor(Number.MAX_SAFE_INTEGER / 2 ** 32)) {
    return 0
  }
  return high * 2 ** 32 + low
}

type Mp4Box = {
  type: string
  start: number
  end: number
  dataStart: number
}

const MAX_MP4_METADATA_BYTES = 16 * 1024 * 1024

function readMp4Boxes(
  view: DataView,
  start: number,
  end: number,
  onBox: (box: Mp4Box) => void
): void {
  let offset = start
  while (offset + 8 <= end) {
    const size32 = view.getUint32(offset)
    const type = readAscii(view, offset + 4, 4)
    let headerSize = 8
    let size = size32

    if (size32 === 1 && offset + 16 <= end) {
      size = readUint64(view, offset + 8)
      headerSize = 16
    } else if (size32 === 0) {
      size = end - offset
    }

    if (size < headerSize || offset + size > end) {
      break
    }

    onBox({
      type,
      start: offset,
      end: offset + size,
      dataStart: offset + headerSize,
    })
    offset += size
  }
}

export function parseMp4VideoFrameRate(buffer: ArrayBuffer): number | null {
  const view = new DataView(buffer)
  let frameRate: number | null = null

  readMp4Boxes(view, 0, view.byteLength, box => {
    if (box.type !== 'moov' || frameRate != null) return

    readMp4Boxes(view, box.dataStart, box.end, trackBox => {
      if (trackBox.type !== 'trak' || frameRate != null) return

      let handlerType: string | null = null
      let timescale = 0
      let duration = 0
      let sampleCount = 0

      const visitTrackBox = (start: number, end: number) => {
        readMp4Boxes(view, start, end, child => {
          if (child.type === 'hdlr' && child.dataStart + 12 <= child.end) {
            handlerType = readAscii(view, child.dataStart + 8, 4)
            return
          }

          if (child.type === 'mdhd') {
            const version = view.getUint8(child.dataStart)
            if (version === 1 && child.dataStart + 32 <= child.end) {
              timescale = view.getUint32(child.dataStart + 20)
              duration = readUint64(view, child.dataStart + 24)
            } else if (version === 0 && child.dataStart + 24 <= child.end) {
              timescale = view.getUint32(child.dataStart + 12)
              duration = view.getUint32(child.dataStart + 16)
            }
            return
          }

          if (child.type === 'stts' && child.dataStart + 8 <= child.end) {
            const entryCount = view.getUint32(child.dataStart + 4)
            let entryOffset = child.dataStart + 8
            for (let index = 0; index < entryCount && entryOffset + 8 <= child.end; index += 1) {
              sampleCount += view.getUint32(entryOffset)
              entryOffset += 8
            }
            return
          }

          if (['mdia', 'minf', 'stbl'].includes(child.type)) {
            visitTrackBox(child.dataStart, child.end)
          }
        })
      }

      visitTrackBox(trackBox.dataStart, trackBox.end)
      if (handlerType === 'vide' && timescale > 0 && duration > 0 && sampleCount > 0) {
        frameRate = sampleCount / (duration / timescale)
      }
    })
  })

  return frameRate
}

export async function readVideoFrameRate(file: File): Promise<number | null> {
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (!['mp4', 'mov', 'm4v'].includes(extension ?? '')) {
    return null
  }

  try {
    if (file.size <= MAX_MP4_METADATA_BYTES) {
      return parseMp4VideoFrameRate(await file.arrayBuffer())
    }

    const head = await file.slice(0, MAX_MP4_METADATA_BYTES).arrayBuffer()
    const headFrameRate = parseMp4VideoFrameRate(head)
    if (headFrameRate !== null) {
      return headFrameRate
    }

    const tailOffset = Math.max(0, file.size - MAX_MP4_METADATA_BYTES)
    const tail = await file.slice(tailOffset).arrayBuffer()
    const moovBox = extractMp4Box(tail, 'moov')
    return moovBox ? parseMp4VideoFrameRate(moovBox) : null
  } catch {
    return null
  }
}

function extractMp4Box(buffer: ArrayBuffer, boxType: string): ArrayBuffer | null {
  const view = new DataView(buffer)
  for (let offset = 4; offset + 4 <= view.byteLength; offset += 1) {
    if (readAscii(view, offset, 4) !== boxType) continue

    const sizeOffset = offset - 4
    const size = view.getUint32(sizeOffset)
    if (size < 8 || sizeOffset + size > view.byteLength) continue
    return buffer.slice(sizeOffset, sizeOffset + size)
  }
  return null
}
