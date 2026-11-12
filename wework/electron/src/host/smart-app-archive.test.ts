import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as yauzl from 'yauzl'
import { extractSmartAppArchive } from './smart-app-package-validator.js'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Smart App ZIP extraction', () => {
  test.each([64 * 1024 - 32, 64 * 1024, 256 * 1024])(
    'extracts every byte and the following entry across the 64 KiB stream boundary (%i bytes)',
    async size => {
      const bytes = randomBytes(size)
      const { archive, destination } = await fixture([
        { name: 'package/client.js', bytes },
        { name: 'tail.txt', bytes: Buffer.from('archive completed') },
      ])

      await extractSmartAppArchive(archive, destination)

      const extracted = await readFile(join(destination, 'package/client.js'))
      expect(extracted.equals(bytes)).toBe(true)
      await expect(readFile(join(destination, 'tail.txt'), 'utf8')).resolves.toBe(
        'archive completed'
      )
    }
  )

  test('extracts highly compressible large entries and many individually small entries', async () => {
    const files = [
      { name: 'compressible.bin', bytes: Buffer.alloc(1024 * 1024, 65) },
      ...Array.from({ length: 20 }, (_, index) => ({
        name: `small-${index}.bin`,
        bytes: randomBytes(60 * 1024),
      })),
    ]
    const { archive, destination } = await fixture(files)

    await extractSmartAppArchive(archive, destination)

    for (const file of files) {
      const extracted = await readFile(join(destination, file.name))
      expect(extracted.equals(file.bytes), file.name).toBe(true)
    }
  })

  test.each(['../escape.txt', '/absolute.txt', 'C:/escape.txt', 'folder\\escape.txt'])(
    'rejects unsafe entry %s and removes partially extracted files',
    async name => {
      const { archive, destination } = await fixture([{ name: 'first.txt' }, { name }])

      await expect(extractSmartAppArchive(archive, destination)).rejects.toThrow()

      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(destination, '..', 'escape.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  )

  test.each([0o120777, 0o010644])('rejects symbolic links and special files (%i)', async mode => {
    const { archive, destination } = await fixture([{ name: 'link', mode }])

    await expect(extractSmartAppArchive(archive, destination)).rejects.toThrow(
      mode === 0o120777 ? 'symbolic link' : 'special file'
    )
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects duplicate paths without overwriting files', async () => {
    const { archive, destination } = await fixture([{ name: 'same.txt' }, { name: 'same.txt' }])

    await expect(extractSmartAppArchive(archive, destination)).rejects.toMatchObject({
      code: 'EEXIST',
    })
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('enforces the cumulative extracted size and cleans up after failure', async () => {
    const { archive, destination } = await fixture([
      { name: 'first.txt', bytes: Buffer.alloc(10) },
      { name: 'second.txt', bytes: Buffer.alloc(10) },
    ])

    await expect(
      extractSmartAppArchive(archive, destination, { maxExtractedBytes: 15 })
    ).rejects.toMatchObject({ code: 'SA-PACKAGE-EXTRACTED-SIZE' })
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects inflated bytes beyond the declared entry size', async () => {
    const { archive, destination } = await fixture([
      { name: 'oversized.bin', bytes: randomBytes(256 * 1024), declaredSize: 1 },
    ])

    await expect(extractSmartAppArchive(archive, destination)).rejects.toThrow('too many bytes')
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rejects a truncated ZIP and can extract a valid archive afterwards', async () => {
    const { archive, destination } = await fixture([{ name: 'file.txt' }])
    const bytes = await readFile(archive)
    await writeFile(archive, bytes.subarray(0, bytes.length - 12))
    await expect(extractSmartAppArchive(archive, destination)).rejects.toThrow()
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(archive, bytes)
    await extractSmartAppArchive(archive, destination)
    await expect(readdir(destination)).resolves.toEqual(['file.txt'])
  })

  test('times out a stalled stream, closes the ZIP and removes partial output', async () => {
    const { archive, destination } = await fixture([{ name: 'stalled.bin' }])
    const stalled = new Readable({ read() {} })
    let started!: () => void
    const streamStarted = new Promise<void>(resolve => {
      started = resolve
    })
    vi.spyOn(yauzl.ZipFile.prototype, 'openReadStreamPromise').mockImplementation(async () => {
      started()
      return stalled
    })
    const close = vi.spyOn(yauzl.ZipFile.prototype, 'close')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const extraction = extractSmartAppArchive(archive, destination)
    const rejected = expect(extraction).rejects.toMatchObject({
      code: 'SA-PACKAGE-EXTRACT-TIMEOUT',
    })
    await streamStarted
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected

    expect(stalled.destroyed).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(vi.getTimerCount()).toBe(0)
  })

  test('cancels pending entry enumeration, closes the ZIP and allows a subsequent extraction', async () => {
    const { archive, destination } = await fixture([{ name: 'file.txt' }])
    const controller = new AbortController()
    const close = vi.spyOn(yauzl.ZipFile.prototype, 'close')
    const readEntry = vi.spyOn(yauzl.ZipFile.prototype, 'readEntry').mockImplementation(() => {
      controller.abort(new Error('Extraction cancelled'))
    })

    await expect(
      extractSmartAppArchive(archive, destination, { signal: controller.signal })
    ).rejects.toThrow('Extraction cancelled')
    expect(close).toHaveBeenCalledOnce()
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })

    readEntry.mockRestore()
    await extractSmartAppArchive(archive, destination)
    await expect(readdir(destination)).resolves.toEqual(['file.txt'])
  })

  test('cancels while opening an entry stream and destroys a stream returned after cancellation', async () => {
    const { archive, destination } = await fixture([{ name: 'file.txt' }])
    const controller = new AbortController()
    let resolveStream!: (source: Readable) => void
    vi.spyOn(yauzl.ZipFile.prototype, 'openReadStreamPromise').mockImplementation(
      () =>
        new Promise<Readable>(resolve => {
          resolveStream = resolve
          controller.abort(new Error('Entry opening cancelled'))
        })
    )
    const close = vi.spyOn(yauzl.ZipFile.prototype, 'close')

    await expect(
      extractSmartAppArchive(archive, destination, { signal: controller.signal })
    ).rejects.toThrow('Entry opening cancelled')
    expect(close).toHaveBeenCalledOnce()
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })

    const source = new Readable({ read() {} })
    resolveStream(source)
    await Promise.resolve()
    expect(source.destroyed).toBe(true)
  })
})

interface ZipEntryFixture {
  name: string
  bytes?: Buffer
  mode?: number
  declaredSize?: number
}

async function fixture(entries: ZipEntryFixture[]) {
  const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-extraction-'))
  roots.push(root)
  const archive = join(root, 'package.zip')
  await writeFile(archive, zipBytes(entries))
  return { archive, destination: join(root, 'extracted') }
}

// Write central-directory metadata directly so malformed paths and sizes are not sanitized by a ZIP writer.
function zipBytes(entries: ZipEntryFixture[]): Buffer {
  const locals: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const bytes = entry.bytes ?? Buffer.from('fixture')
    const compressed = deflateRawSync(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(bytes), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.declaredSize ?? bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(bytes), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.declaredSize ?? bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    directory.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}
