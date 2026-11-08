import { on, once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'

// UV archives contain regular executables, never links or special files.
export async function extractPythonBootstrapZip(
  archive: string,
  destination: string
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const root = await realpath(destination)
  const zip = await yauzl.openPromise(archive, {
    lazyEntries: true,
    autoClose: false,
    strictFileNames: true,
  })
  const controller = new AbortController()
  const abort = (error: Error) => controller.abort(error)
  zip.on('error', abort)
  try {
    const entries = on(zip, 'entry', { signal: controller.signal, close: ['end'] })
    zip.readEntry()
    for await (const [entry] of entries as AsyncIterable<[yauzl.Entry]>) {
      const type = (entry.externalFileAttributes >>> 16) & 0o170000
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
        throw new Error('Python bootstrap ZIP contains a link or special file')
      }
      const target = join(root, entry.fileName)
      assertContained(root, target)
      const directory = type === 0o040000 || entry.fileName.endsWith('/')
      await prepareDirectories(root, directory ? target : dirname(target))
      if (!directory) {
        const source = await zip.openReadStreamPromise(entry)
        await pipeline(source, createWriteStream(target, { flags: 'wx', mode: 0o600 }), {
          signal: controller.signal,
        })
      }
      zip.readEntry()
    }
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error
  } finally {
    try {
      const closed = once(zip, 'close')
      zip.close()
      await closed
    } finally {
      zip.off('error', abort)
    }
  }
}

async function prepareDirectories(root: string, directory: string): Promise<void> {
  let current = root
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    assertContained(root, await realpath(current))
  }
}

function assertContained(root: string, target: string): void {
  const path = relative(root, target)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('Out of bound path in Python bootstrap ZIP')
  }
}
