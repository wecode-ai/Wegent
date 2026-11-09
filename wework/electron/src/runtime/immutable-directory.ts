import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises'
import { dirname, join, toNamespacedPath } from 'node:path'

const publications = new Map<string, Promise<string>>()

export async function publishImmutableDirectory(
  target: string,
  populate: (content: string) => Promise<void>,
  isReady: (path: string) => Promise<boolean> = directoryExists
): Promise<string> {
  return publishOnce(target, () => publish(target, populate, isReady))
}

/** Reference immutable content whose owner outlives individual release slots. */
export function linkImmutableDirectory(
  target: string,
  source: string,
  isReady: (path: string) => Promise<boolean>
): Promise<string> {
  return publishOnce(target, async () => {
    if (await isReady(target)) return target
    if (!(await isReady(source))) throw new Error('Shared immutable content is not ready')
    const content = await realpath(source)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rm(target, { recursive: true, force: true })
    await symlink(content, target, process.platform === 'win32' ? 'junction' : 'dir')
    return target
  })
}

async function publishOnce(target: string, create: () => Promise<string>): Promise<string> {
  const active = publications.get(target)
  if (active) return active
  const publication = create()
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
  // An alias can belong to a shorter-lived release or checkpoint. Publish a
  // physical address so the completed tree outlives that caller's alias.
  const parent = await realpath(dirname(target))
  const content = await mkdtemp(toNamespacedPath(join(parent, '.content-')))
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
