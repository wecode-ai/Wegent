import { describe, expect, test } from 'vitest'
import { createQrCodeModules } from './qrCodeSvg'

const QR_VERSION = 6
const QR_SIZE = QR_VERSION * 4 + 17
const QR_DATA_CODEWORDS = 136
const QR_BLOCK_COUNT = 2
const QR_BLOCK_DATA_CODEWORDS = 68
const QR_ECC_CODEWORDS = 18
const QR_BYTE_CAPACITY = 134

function createReservedMatrix() {
  const reserved = Array.from({ length: QR_SIZE }, () => new Array<boolean>(QR_SIZE).fill(false))

  const reserve = (x: number, y: number) => {
    if (x >= 0 && x < QR_SIZE && y >= 0 && y < QR_SIZE) reserved[y][x] = true
  }
  const reserveFinder = (centerX: number, centerY: number) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) reserve(centerX + dx, centerY + dy)
    }
  }
  const reserveAlignment = (centerX: number, centerY: number) => {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) reserve(centerX + dx, centerY + dy)
    }
  }

  for (let i = 0; i < QR_SIZE; i += 1) {
    reserve(6, i)
    reserve(i, 6)
  }
  reserveFinder(3, 3)
  reserveFinder(QR_SIZE - 4, 3)
  reserveFinder(3, QR_SIZE - 4)
  reserveAlignment(34, 34)
  reserve(8, QR_SIZE - 8)
  for (let i = 0; i <= 5; i += 1) reserve(8, i)
  reserve(8, 7)
  reserve(8, 8)
  reserve(7, 8)
  for (let i = 9; i < 15; i += 1) reserve(14 - i, 8)
  for (let i = 0; i < 8; i += 1) reserve(QR_SIZE - 1 - i, 8)
  for (let i = 8; i < 15; i += 1) reserve(8, QR_SIZE - 15 + i)

  return reserved
}

function readCodewords(modules: boolean[][]): number[] {
  const reserved = createReservedMatrix()
  const bits: number[] = []

  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < QR_SIZE; vertical += 1) {
      const upward = ((QR_SIZE - 1 - right) & 2) === 0
      const y = upward ? QR_SIZE - 1 - vertical : vertical
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset
        if (reserved[y][x]) continue
        const unmasked = modules[y][x] !== ((x + y) % 2 === 0)
        bits.push(unmasked ? 1 : 0)
      }
    }
  }

  const codewordCount = QR_DATA_CODEWORDS + QR_BLOCK_COUNT * QR_ECC_CODEWORDS
  return Array.from({ length: codewordCount }, (_, index) =>
    Number.parseInt(bits.slice(index * 8, index * 8 + 8).join(''), 2)
  )
}

function readBits(bits: number[], cursor: { offset: number }, length: number): number {
  let value = 0
  for (let i = 0; i < length; i += 1) {
    value = (value << 1) | bits[cursor.offset]
    cursor.offset += 1
  }
  return value
}

function decodeByteModeQr(modules: boolean[][]): string {
  const codewords = readCodewords(modules)
  const interleavedData = codewords.slice(0, QR_DATA_CODEWORDS)
  const data: number[] = []
  for (let block = 0; block < QR_BLOCK_COUNT; block += 1) {
    for (let index = 0; index < QR_BLOCK_DATA_CODEWORDS; index += 1) {
      data.push(interleavedData[index * QR_BLOCK_COUNT + block])
    }
  }
  const bits = data.flatMap(byte =>
    Array.from({ length: 8 }, (_, index) => (byte >>> (7 - index)) & 1)
  )
  const cursor = { offset: 0 }
  expect(readBits(bits, cursor, 4)).toBe(0x4)
  const byteLength = readBits(bits, cursor, 8)
  const bytes = Array.from({ length: byteLength }, () => readBits(bits, cursor, 8))
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

function urlAtSupportedCapacityBoundary(): string {
  const prefix = 'https://example.test/'
  const prefixBytes = new TextEncoder().encode(prefix).length
  return `${prefix}${'a'.repeat(QR_BYTE_CAPACITY - prefixBytes)}`
}

describe('createQrCodeModules', () => {
  test('creates a QR code that decodes to a normal experience URL', () => {
    const experienceUrl = 'https://mini.example.test/experience/1234567890'

    expect(decodeByteModeQr(createQrCodeModules(experienceUrl))).toBe(experienceUrl)
  })

  test('creates a QR code that decodes at the supported capacity boundary', () => {
    const experienceUrl = urlAtSupportedCapacityBoundary()

    expect(new TextEncoder().encode(experienceUrl)).toHaveLength(QR_BYTE_CAPACITY)
    expect(decodeByteModeQr(createQrCodeModules(experienceUrl))).toBe(experienceUrl)
  })
})
