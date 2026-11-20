import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { hashComponentPath, sha256 } from './component-content-hash.js'
import { publishImmutableDirectory } from './immutable-directory.js'
import { extractPhysicalRelease } from './physical-release-files.js'

export interface BundledComponentArchive {
  path: string
  sha256: string
  bytes: number
}

export type ComponentPreparationReporter = (
  step: string,
  status: 'started' | 'completed',
  details?: Record<string, unknown>
) => void

/** Keep bundled small files inside one signed archive until target-owned preparation. */
export async function materializeBundledComponentArchive(
  resources: string,
  cache: string,
  archive: BundledComponentArchive,
  contentSha256: string,
  report?: ComponentPreparationReporter
): Promise<string> {
  const source = resolve(resources, archive.path)
  const child = relative(resolve(resources), source)
  if (
    isAbsolute(archive.path) ||
    !child ||
    child === '..' ||
    child.startsWith('../') ||
    child.startsWith('..\\') ||
    isAbsolute(child) ||
    !/^[a-f0-9]{64}$/.test(archive.sha256) ||
    !/^[a-f0-9]{64}$/.test(contentSha256) ||
    !Number.isSafeInteger(archive.bytes) ||
    archive.bytes <= 0
  )
    throw new Error('Bundled component archive metadata is invalid')
  const physicalChild = relative(await realpath(resources), await realpath(source))
  if (
    physicalChild === '..' ||
    physicalChild.startsWith('../') ||
    physicalChild.startsWith('..\\') ||
    isAbsolute(physicalChild)
  )
    throw new Error('Bundled component archive escapes its package')
  report?.('archive-checksum', 'started', { bytes: archive.bytes })
  const metadata = await stat(source)
  if (
    !metadata.isFile() ||
    metadata.size !== archive.bytes ||
    (await sha256(source)) !== archive.sha256
  )
    throw new Error('Bundled component archive integrity mismatch')
  report?.('archive-checksum', 'completed')
  const matches = async (path: string) => {
    try {
      const physicalPath = await realpath(path)
      report?.('content-checksum', 'started')
      const matchesContent = (await hashComponentPath(physicalPath)) === contentSha256
      report?.('content-checksum', 'completed', { matches: matchesContent })
      return matchesContent
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  const published = await publishImmutableDirectory(
    join(cache, archive.sha256),
    async content => {
      report?.('extract-archive', 'started')
      await extractPhysicalRelease(source, content)
      report?.('extract-archive', 'completed')
      if (!(await matches(content))) throw new Error('Bundled component content checksum mismatch')
    },
    matches
  )
  return realpath(published)
}
