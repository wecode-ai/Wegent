import { createHash } from 'node:crypto'

const recordBytes = 36
const maxBlockBytes = 5 * 1024 * 1024
const maxIndexBytes = 4 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/

export function validReleaseBlockMap(map) {
  return (
    map &&
    typeof map.sha256 === 'string' &&
    SHA256.test(map.sha256) &&
    Number.isSafeInteger(map.bytes) &&
    map.bytes > 0 &&
    map.bytes <= maxIndexBytes &&
    map.bytes % recordBytes === 0
  )
}

export function encodeReleaseBlocks(blocks) {
  const index = Buffer.alloc(blocks.length * recordBytes)
  let offset = 0
  for (const [bytes, sha256] of blocks) {
    index.writeUInt32LE(bytes, offset)
    index.write(sha256, offset + 4, 32, 'hex')
    offset += recordBytes
  }
  return index
}

export function decodeReleaseBlocks(index, map, archiveBytes) {
  if (
    !validReleaseBlockMap(map) ||
    index.length !== map.bytes ||
    createHash('sha256').update(index).digest('hex') !== map.sha256
  )
    throw new Error('Release block map integrity check failed')
  const blocks = []
  let total = 0
  for (let offset = 0; offset < index.length; offset += recordBytes) {
    const bytes = index.readUInt32LE(offset)
    total += bytes
    if (!bytes || bytes > maxBlockBytes || total > archiveBytes)
      throw new Error('Invalid release block length')
    blocks.push([bytes, index.toString('hex', offset + 4, offset + recordBytes)])
  }
  if (total !== archiveBytes) throw new Error('Release block map does not cover the archive')
  return blocks
}
