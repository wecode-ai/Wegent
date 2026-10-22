import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const publications = new Map<string, Promise<string>>()

export async function publishImmutableDirectory(
  target: string,
  populate: (content: string) => Promise<void>,
  isReady: (path: string) => Promise<boolean> = directoryExists
): Promise<string> {
  const active = publications.get(target)
  if (active) return active
  const publication = publish(target, populate, isReady)
  publications.set(target, publication)
  try {
    return await publication
  } finally {
    publications.delete(target)
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function publish(
  target: string,
  populate: (content: string) => Promise<void>,
  isReady: (path: string) => Promise<boolean>
): Promise<string> {
  if (await isReady(target)) return target
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const content = await mkdtemp(join(dirname(target), '.content-'))
  let published = false
  try {
    await populate(content)
    await rm(target, { recursive: true, force: true })
    // Publish a completed tree without renaming files that Windows may have open.
    await symlink(content, target, process.platform === 'win32' ? 'junction' : 'dir')
    published = true
    return target
  } finally {
    if (!published) await rm(content, { recursive: true, force: true })
  }
}
