const QR_VERSION = 6
const QR_SIZE = QR_VERSION * 4 + 17
const QR_DATA_CODEWORDS = 136
const QR_BLOCK_COUNT = 2
const QR_BLOCK_DATA_CODEWORDS = 68
const QR_ECC_CODEWORDS = 18
const QR_QUIET_ZONE = 4

const EXP_TABLE = new Array<number>(512)
const LOG_TABLE = new Array<number>(256)

let value = 1
for (let i = 0; i < 255; i += 1) {
  EXP_TABLE[i] = value
  LOG_TABLE[value] = i
  value <<= 1
  if (value & 0x100) value ^= 0x11d
}
for (let i = 255; i < 512; i += 1) {
  EXP_TABLE[i] = EXP_TABLE[i - 255]
}

function multiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]]
}

function createGenerator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = multiply(result[j], EXP_TABLE[i])
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
  }
  return result
}

function createEcc(data: number[], generator: number[]): number[] {
  const result = new Array<number>(generator.length).fill(0)
  for (const dataByte of data) {
    const factor = dataByte ^ result.shift()!
    result.push(0)
    for (let i = 0; i < generator.length; i += 1) {
      result[i] ^= multiply(generator[i], factor)
    }
  }
  return result
}

function appendBits(bits: number[], valueToAppend: number, length: number) {
  for (let i = length - 1; i >= 0; i -= 1) {
    bits.push((valueToAppend >>> i) & 1)
  }
}

function encodeUrlBytes(url: string): number[] {
  const bytes = [...new TextEncoder().encode(url)]
  const bits: number[] = []
  appendBits(bits, 0x4, 4)
  appendBits(bits, bytes.length, 8)
  for (const byte of bytes) appendBits(bits, byte, 8)

  const capacityBits = QR_DATA_CODEWORDS * 8
  if (bits.length > capacityBits) {
    throw new Error('QR input is too long')
  }
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)

  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    data.push(Number.parseInt(bits.slice(i, i + 8).join(''), 2))
  }
  for (let pad = 0xec; data.length < QR_DATA_CODEWORDS; pad ^= 0xec ^ 0x11) {
    data.push(pad)
  }
  return data
}

function createMatrix() {
  return {
    modules: Array.from({ length: QR_SIZE }, () => new Array<boolean>(QR_SIZE).fill(false)),
    reserved: Array.from({ length: QR_SIZE }, () => new Array<boolean>(QR_SIZE).fill(false)),
  }
}

function setFunctionModule(
  modules: boolean[][],
  reserved: boolean[][],
  x: number,
  y: number,
  dark: boolean
) {
  modules[y][x] = dark
  reserved[y][x] = true
}

function drawFinderPattern(
  modules: boolean[][],
  reserved: boolean[][],
  centerX: number,
  centerY: number
) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = centerX + dx
      const y = centerY + dy
      if (x < 0 || x >= QR_SIZE || y < 0 || y >= QR_SIZE) continue
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      setFunctionModule(modules, reserved, x, y, distance !== 2 && distance !== 4)
    }
  }
}

function drawAlignmentPattern(
  modules: boolean[][],
  reserved: boolean[][],
  centerX: number,
  centerY: number
) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      setFunctionModule(modules, reserved, centerX + dx, centerY + dy, distance !== 1)
    }
  }
}

function drawFunctionPatterns(modules: boolean[][], reserved: boolean[][]) {
  for (let i = 0; i < QR_SIZE; i += 1) {
    setFunctionModule(modules, reserved, 6, i, i % 2 === 0)
    setFunctionModule(modules, reserved, i, 6, i % 2 === 0)
  }

  drawFinderPattern(modules, reserved, 3, 3)
  drawFinderPattern(modules, reserved, QR_SIZE - 4, 3)
  drawFinderPattern(modules, reserved, 3, QR_SIZE - 4)

  const alignmentPositions = [6, 34]
  for (const y of alignmentPositions) {
    for (const x of alignmentPositions) {
      const overlapsFinder = (x === 6 && y === 6) || (x === 34 && y === 6) || (x === 6 && y === 34)
      if (!overlapsFinder) drawAlignmentPattern(modules, reserved, x, y)
    }
  }

  setFunctionModule(modules, reserved, 8, QR_SIZE - 8, true)
  drawFormatBits(modules, reserved, 0)
}

function getFormatBits(mask: number): number {
  const data = (1 << 3) | mask
  let remainder = data
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537)
  }
  return ((data << 10) | remainder) ^ 0x5412
}

function drawFormatBits(modules: boolean[][], reserved: boolean[][], mask: number) {
  const bits = getFormatBits(mask)
  for (let i = 0; i <= 5; i += 1) setFunctionModule(modules, reserved, 8, i, bit(bits, i))
  setFunctionModule(modules, reserved, 8, 7, bit(bits, 6))
  setFunctionModule(modules, reserved, 8, 8, bit(bits, 7))
  setFunctionModule(modules, reserved, 7, 8, bit(bits, 8))
  for (let i = 9; i < 15; i += 1) setFunctionModule(modules, reserved, 14 - i, 8, bit(bits, i))
  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(modules, reserved, QR_SIZE - 1 - i, 8, bit(bits, i))
  }
  for (let i = 8; i < 15; i += 1) {
    setFunctionModule(modules, reserved, 8, QR_SIZE - 15 + i, bit(bits, i))
  }
}

function bit(valueToRead: number, index: number): boolean {
  return ((valueToRead >>> index) & 1) !== 0
}

function addErrorCorrection(data: number[]): number[] {
  const generator = createGenerator(QR_ECC_CODEWORDS)
  const blocks = Array.from({ length: QR_BLOCK_COUNT }, (_, blockIndex) =>
    data.slice(blockIndex * QR_BLOCK_DATA_CODEWORDS, (blockIndex + 1) * QR_BLOCK_DATA_CODEWORDS)
  )
  const eccBlocks = blocks.map(block => createEcc(block, generator))
  const result: number[] = []

  for (let i = 0; i < QR_BLOCK_DATA_CODEWORDS; i += 1) {
    for (const block of blocks) result.push(block[i])
  }
  for (let i = 0; i < QR_ECC_CODEWORDS; i += 1) {
    for (const block of eccBlocks) result.push(block[i])
  }
  return result
}

function drawCodewords(modules: boolean[][], reserved: boolean[][], codewords: number[]) {
  let bitIndex = 0
  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < QR_SIZE; vertical += 1) {
      const upward = ((QR_SIZE - 1 - right) & 2) === 0
      const y = upward ? QR_SIZE - 1 - vertical : vertical
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset
        if (reserved[y][x]) continue
        const dark =
          bitIndex < codewords.length * 8 &&
          ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0
        modules[y][x] = dark !== ((x + y) % 2 === 0)
        bitIndex += 1
      }
    }
  }
}

export function createQrCodeModules(url: string): boolean[][] {
  const data = encodeUrlBytes(url)
  const codewords = addErrorCorrection(data)
  const { modules, reserved } = createMatrix()
  drawFunctionPatterns(modules, reserved)
  drawCodewords(modules, reserved, codewords)
  return modules
}

export function qrCodeViewBox(): string {
  const size = QR_SIZE + QR_QUIET_ZONE * 2
  return `0 0 ${size} ${size}`
}

export function qrCodeOffset(): number {
  return QR_QUIET_ZONE
}
