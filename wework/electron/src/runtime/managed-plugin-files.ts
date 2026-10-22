import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

export async function copyManagedPlugin(
  source: string,
  destination: string,
  options: { platform?: NodeJS.Platform } = {}
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') {
    await cp(source, destination, { recursive: true })
    return
  }
  await copyWindowsEntry(source, destination)
}

async function copyWindowsEntry(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source)
  if (metadata.isSymbolicLink()) {
    // pnpm's Windows package cleanup traverses junctions. Managed packages
    // must own their files so cleanup cannot delete shared component assets.
    await copyWindowsEntry(await realpath(source), destination)
    return
  }
  if (!metadata.isDirectory()) {
    await cp(source, destination)
    return
  }
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source)) {
    await copyWindowsEntry(join(source, entry), join(destination, entry))
  }
}
