import { ZipArchive } from 'archiver'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import {
  MAX_SMART_APP_ARCHIVE_BYTES,
  isSafeSmartAppRelativePath,
} from './smart-app-package-validator.js'

export async function rejectOversizedPublishArchive(
  path: string,
  sizeBytes: number
): Promise<void> {
  if (sizeBytes <= MAX_SMART_APP_ARCHIVE_BYTES) return
  await rm(path, { force: true })
  throw new Error('发布包超过 50 MB，请使用项目打包命令生成发布产物，不要直接上传源码压缩包。')
}

export async function optionalDirectory(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path)
    return (await stat(resolved)).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

export function isDirectoryPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'EACCES' || code === 'EPERM'
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

export function isSecureTransferUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

export async function fileSha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

export async function archiveDirectory(source: string, destination: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(destination, { mode: 0o600 })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolvePromise)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    archive.directory(source, false)
    void archive.finalize()
  })
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function uniquePath(directory: string, filename: string): Promise<string> {
  const path = join(directory, filename)
  if (!(await exists(path))) return path
  const extension = '.zip'
  const stem = filename.endsWith(extension) ? filename.slice(0, -extension.length) : filename
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(directory, `${stem} (${index})${extension}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error('Downloads directory has too many Smart app exports with the same name')
}

export async function localPluginDescriptor(
  source: string,
  packageRoot: string
): Promise<{ spec: string; path: string }> {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
    name?: unknown
    dsh?: { bundle?: { patch?: unknown } }
  }
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : ''
  if (!name) throw new Error('DSH plugin package has no name')
  const patch =
    typeof manifest.dsh?.bundle?.patch === 'string' ? manifest.dsh.bundle.patch.trim() : ''
  if (!isSafeSmartAppRelativePath(patch) || !(await exists(join(source, patch)))) {
    throw new Error('Selected package does not declare a valid dsh.bundle.patch')
  }
  const directoryName = name.replace(/[^0-9A-Za-z_-]/g, '-').replace(/^-+|-+$/g, '')
  if (!directoryName) throw new Error('DSH plugin package name cannot be used as a directory')
  const relativePath = join('plugins', directoryName)
  if (await exists(join(packageRoot, relativePath))) {
    throw new Error('This local DSH plugin is already included')
  }
  const path = relativePath.split(sep).join('/')
  return { spec: `file:${path}`, path }
}
