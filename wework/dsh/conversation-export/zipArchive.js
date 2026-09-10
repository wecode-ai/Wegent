import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'

const DATA_DESCRIPTOR_FLAG = 0x0008
const UTF8_FLAG = 0x0800
const ZIP_FLAGS = DATA_DESCRIPTOR_FLAG | UTF8_FLAG
const MAX_UINT16 = 0xffff
const MAX_UINT32 = 0xffffffff
const CRC32_TABLE = createCrc32Table()

export async function writeZipArchive(destination, entries) {
  if (entries.length > MAX_UINT16) {
    throw new Error('Conversation export archive contains too many entries')
  }

  const output = await open(destination, 'wx', 0o600)
  let offset = 0
  const centralDirectory = []
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8')
      if (name.byteLength > MAX_UINT16) {
        throw new Error(`Conversation export archive path is too long: ${entry.name}`)
      }
      const metadata = await stat(entry.path)
      if (!metadata.isFile()) {
        throw new Error(`Conversation export archive source is not a file: ${entry.name}`)
      }
      if (metadata.size > MAX_UINT32) {
        throw new Error(`Conversation export archive entry exceeds 4 GB: ${entry.name}`)
      }

      const localOffset = offset
      const { date, time } = dosTimestamp(metadata.mtime)
      offset += await writeAll(output, localFileHeader(name, date, time))
      let crc = 0xffffffff
      let size = 0
      for await (const value of createReadStream(entry.path)) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        crc = updateCrc32(crc, chunk)
        size += chunk.byteLength
        offset += await writeAll(output, chunk)
      }
      if (size !== metadata.size) {
        throw new Error(`Conversation export archive source changed while reading: ${entry.name}`)
      }
      crc = (crc ^ 0xffffffff) >>> 0
      offset += await writeAll(output, dataDescriptor(crc, size))
      centralDirectory.push(centralDirectoryHeader(name, date, time, crc, size, localOffset))
      ensureZip32Offset(offset)
    }

    const centralDirectoryOffset = offset
    for (const header of centralDirectory) offset += await writeAll(output, header)
    const centralDirectorySize = offset - centralDirectoryOffset
    ensureZip32Offset(offset)
    offset += await writeAll(
      output,
      endOfCentralDirectory(entries.length, centralDirectorySize, centralDirectoryOffset)
    )
    await output.sync()
    return offset
  } finally {
    await output.close()
  }
}

function localFileHeader(name, date, time) {
  const header = Buffer.alloc(30 + name.byteLength)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(ZIP_FLAGS, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(date, 12)
  header.writeUInt16LE(name.byteLength, 26)
  name.copy(header, 30)
  return header
}

function dataDescriptor(crc, size) {
  const descriptor = Buffer.alloc(16)
  descriptor.writeUInt32LE(0x08074b50, 0)
  descriptor.writeUInt32LE(crc, 4)
  descriptor.writeUInt32LE(size, 8)
  descriptor.writeUInt32LE(size, 12)
  return descriptor
}

function centralDirectoryHeader(name, date, time, crc, size, localOffset) {
  const header = Buffer.alloc(46 + name.byteLength)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(ZIP_FLAGS, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(time, 12)
  header.writeUInt16LE(date, 14)
  header.writeUInt32LE(crc, 16)
  header.writeUInt32LE(size, 20)
  header.writeUInt32LE(size, 24)
  header.writeUInt16LE(name.byteLength, 28)
  header.writeUInt32LE(localOffset, 42)
  name.copy(header, 46)
  return header
}

function endOfCentralDirectory(entryCount, directorySize, directoryOffset) {
  const record = Buffer.alloc(22)
  record.writeUInt32LE(0x06054b50, 0)
  record.writeUInt16LE(entryCount, 8)
  record.writeUInt16LE(entryCount, 10)
  record.writeUInt32LE(directorySize, 12)
  record.writeUInt32LE(directoryOffset, 16)
  return record
}

async function writeAll(handle, buffer) {
  let written = 0
  while (written < buffer.byteLength) {
    const result = await handle.write(buffer, written, buffer.byteLength - written, null)
    if (result.bytesWritten <= 0) {
      throw new Error('Conversation export could not write archive data')
    }
    written += result.bytesWritten
  }
  return written
}

function dosTimestamp(value) {
  const year = Math.max(1980, Math.min(2107, value.getFullYear()))
  return {
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
  }
}

function ensureZip32Offset(value) {
  if (value > MAX_UINT32) {
    throw new Error('Conversation export archive exceeds the 4 GB ZIP limit')
  }
}

function updateCrc32(crc, buffer) {
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc
}

function createCrc32Table() {
  return Array.from({ length: 256 }, (_, index) => {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    return value >>> 0
  })
}
