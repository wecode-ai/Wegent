import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import bundledComponentLayout from '../../electron/scripts/bundled-component-layout.cjs'

const compress = promisify(gzip)
const recordBytes = 512
const minimumBlockBytes = 32 * 1024
const maximumBlockBytes = 8 * minimumBlockBytes
const splitFileBytes = 512 * 1024
const splitMask = 2 * minimumBlockBytes - 1
const splitPattern = 4729
const componentMemberHeaderBytes = 20
const componentMemberExtra = Buffer.from([8, 0, 0x57, 0x57, 4, 0])
const componentArchives = new Set(bundledComponentLayout.directories.map(name => `${name}.tar.gz`))
const gear = Uint32Array.from({ length: 256 }, (_, byte) =>
  createHash('sha256')
    .update(Buffer.from([byte]))
    .digest()
    .readUInt32LE()
)

// Content-defined boundaries re-align after an insertion instead of invalidating
// every later block. Isolating large file bodies keeps metadata out of their blocks.
export async function createPortableReleaseArchive(cwd, path, entries, { component = false } = {}) {
  const { create, Header } = await import('tar')
  const source = create({ cwd, portable: true, noMtime: true }, entries)
  const hash = createHash('sha256')
  const blocks = []
  let bytes = 0
  await pipeline(async function* () {
    for await (const raw of partitionTar(source, Header, component)) {
      const gzip = await compress(raw)
      const compressed = component ? tagComponentMember(gzip) : gzip
      blocks.push([compressed.length, createHash('sha256').update(compressed).digest('hex')])
      hash.update(compressed)
      bytes += compressed.length
      yield compressed
    }
  }, createWriteStream(path))
  return { bytes, blocks, sha256: hash.digest('hex') }
}

function tagComponentMember(gzip) {
  // FEXTRA's WW subfield stores the complete member length. Standard gzip
  // readers skip it, while the enclosing archive can preserve the boundary.
  const header = Buffer.allocUnsafe(componentMemberHeaderBytes)
  gzip.copy(header, 0, 0, 10)
  header[3] = 4
  componentMemberExtra.copy(header, 10)
  header.writeUInt32LE(gzip.length + componentMemberHeaderBytes - 10, 16)
  return Buffer.concat([header, gzip.subarray(10)])
}

function componentMemberLength(data, offset) {
  if (
    data.readUInt32LE(offset) !== 0x04088b1f ||
    !data.subarray(offset + 10, offset + 16).equals(componentMemberExtra)
  )
    return 0
  const bytes = data.readUInt32LE(offset + 16)
  return bytes >= componentMemberHeaderBytes + 8 && bytes <= maximumBlockBytes + 256 ? bytes : 0
}

async function* partitionTar(source, Header, component) {
  let buffered = Buffer.alloc(0)
  let block = Buffer.allocUnsafe(maximumBlockBytes)
  let used = 0
  let bodyBytes = 0
  let largeBody = false
  let fingerprint = 0
  let componentBytes = 0
  for await (const value of source) {
    const data = buffered.length ? Buffer.concat([buffered, value]) : value
    let offset = 0
    while (offset < data.length) {
      let boundary
      if (!bodyBytes) {
        if (data.length - offset < recordBytes) break
        const header = new Header(data, offset)
        const payloadBytes = header.size ?? 0
        bodyBytes = Math.ceil(payloadBytes / recordBytes) * recordBytes
        const nested = !component && componentArchives.has(posix.basename(header.path ?? ''))
        componentBytes = nested ? payloadBytes : 0
        largeBody = bodyBytes >= splitFileBytes || ((component || nested) && bodyBytes > 0)
        data.copy(block, used, offset, offset + recordBytes)
        used += recordBytes
        offset += recordBytes
        boundary = largeBody
      } else {
        if (componentBytes >= componentMemberHeaderBytes) {
          if (data.length - offset < componentMemberHeaderBytes) break
          const member = componentMemberLength(data, offset)
          if (member && member <= componentBytes) {
            if (data.length - offset < member) break
            yield data.subarray(offset, offset + member)
            offset += member
            componentBytes -= member
            bodyBytes -= member
            continue
          }
          componentBytes = 0
        }
        const limit = Math.min(data.length - offset, bodyBytes, maximumBlockBytes - used)
        let length = limit
        if (largeBody) {
          const firstByte = Math.max(0, minimumBlockBytes - used)
          for (let index = firstByte; index < limit; index++) {
            fingerprint = (fingerprint << 1) + gear[data[offset + index]]
            if ((fingerprint & splitMask) === splitPattern) {
              length = index + 1
              boundary = true
              break
            }
          }
        }
        data.copy(block, used, offset, offset + length)
        used += length
        offset += length
        bodyBytes -= length
        boundary ||= largeBody && !bodyBytes
      }
      if (used === maximumBlockBytes || boundary) {
        yield block.subarray(0, used)
        block = Buffer.allocUnsafe(maximumBlockBytes)
        used = 0
        fingerprint = 0
      }
    }
    buffered = data.subarray(offset)
  }
  if (buffered.length || bodyBytes) throw new Error('Incomplete portable release tar stream')
  if (used) yield block.subarray(0, used)
}
