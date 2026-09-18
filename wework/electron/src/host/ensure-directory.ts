import { mkdir, stat } from 'node:fs/promises'

interface DirectoryMetadata {
  isDirectory(): boolean
}

interface DirectoryFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  stat(path: string): Promise<DirectoryMetadata>
}

const defaultFileSystem: DirectoryFileSystem = { mkdir, stat }

export async function ensureDirectory(
  path: string,
  fileSystem: DirectoryFileSystem = defaultFileSystem
): Promise<void> {
  try {
    const metadata = await fileSystem.stat(path)
    if (!metadata.isDirectory()) {
      throw new Error(`Expected a directory at ${path}`)
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error
    await fileSystem.mkdir(path, { recursive: true })
  }
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
