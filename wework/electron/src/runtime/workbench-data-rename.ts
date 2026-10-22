import * as fs from 'node:fs'

const renameWait = new Int32Array(new SharedArrayBuffer(4))

function identity(path: string): string | undefined {
  try {
    const entry = fs.lstatSync(path, { bigint: true })
    return `${entry.dev}:${entry.ino}:${entry.mode}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// Windows can briefly deny replacement while another handle is closing or a
// scanner reads a newly published journal. Keep the atomic rename and its owned
// entries intact while allowing those handles to close; never unlink to replace.
export function renameWorkbenchData(
  source: string,
  target: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') return fs.renameSync(source, target)
  const original = identity(source)
  const destination = identity(target)
  const deadline = Date.now() + 2_000
  let waiting = false
  while (true) {
    try {
      fs.renameSync(source, target)
      return
    } catch (error) {
      const remaining = deadline - Date.now()
      if (
        !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') ||
        remaining <= 0
      )
        throw error
      if (!waiting) {
        console.warn('[migration] waiting for Windows file handles', { source, target })
        waiting = true
      }
      Atomics.wait(renameWait, 0, 0, Math.min(50, remaining))
      if (identity(source) !== original || identity(target) !== destination) throw error
    }
  }
}
