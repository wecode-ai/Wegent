import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  requiredSmartAppDirectory,
  SmartAppPackageValidationError,
} from './smart-app-package-validator.js'

export type SmartAppFingerprintPurpose = 'verification-input' | 'deliverable'

const OPERATIONAL_DIRECTORIES = new Set(['.git', 'node_modules', 'test-results'])
const BUILD_DIRECTORIES = new Set(['.next', '.turbo', 'build', 'coverage', 'dist', 'out'])

interface FingerprintFile {
  path: string
  bytes: Buffer
}

export async function fingerprintSmartAppDirectory(
  projectRoot: string,
  purpose: SmartAppFingerprintPurpose
): Promise<string> {
  const rootMetadata = await lstat(projectRoot)
  if (rootMetadata.isSymbolicLink()) throw symlinkError(projectRoot)
  const root = await requiredSmartAppDirectory(projectRoot, 'Smart app package')
  const files: FingerprintFile[] = []
  await collectFingerprintFiles(root, '', purpose, files)
  const hash = createHash('sha256')
  hash.update(`smart-app:${purpose}:v1\0`)
  for (const file of files) {
    hash.update(`${Buffer.byteLength(file.path)}:`)
    hash.update(file.path)
    hash.update(`${file.bytes.byteLength}:`)
    hash.update(file.bytes)
  }
  return hash.digest('hex')
}

async function collectFingerprintFiles(
  root: string,
  directory: string,
  purpose: SmartAppFingerprintPurpose,
  files: FingerprintFile[]
): Promise<void> {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  entries.sort((left, right) => compareNames(left.name, right.name))
  for (const entry of entries) {
    const path = normalizedRelativePath(directory, entry.name)
    const absolutePath = join(root, path)
    if (entry.isSymbolicLink()) throw symlinkError(absolutePath)
    if (entry.isDirectory()) {
      if (!ignoreDirectory(entry.name, purpose)) {
        await collectFingerprintFiles(root, path, purpose, files)
      }
      continue
    }
    if (!entry.isFile()) {
      throw new SmartAppPackageValidationError(
        'SA-PACKAGE-FILE-TYPE',
        'Smart app package contains an unsupported file type',
        absolutePath
      )
    }
    if (!ignoreFile(entry.name, purpose)) {
      files.push({ path, bytes: await readFile(absolutePath) })
    }
  }
}

function normalizedRelativePath(directory: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new SmartAppPackageValidationError(
      'SA-PACKAGE-PATH',
      'Smart app package contains a path that cannot be normalized'
    )
  }
  return directory ? `${directory}/${name}` : name
}

function ignoreDirectory(name: string, purpose: SmartAppFingerprintPurpose): boolean {
  if (OPERATIONAL_DIRECTORIES.has(name)) return true
  return purpose === 'verification-input' && (BUILD_DIRECTORIES.has(name) || name === 'docs')
}

function ignoreFile(name: string, purpose: SmartAppFingerprintPurpose): boolean {
  if (/\.zip$/i.test(name)) return true
  if (/^\.env(?:\.|$)/i.test(name) || /\.(?:key|pem)$/i.test(name)) return true
  if (purpose === 'deliverable' && name === 'smart-app.verify.json') return true
  return purpose === 'verification-input' && /\.(?:md|mdx)$/i.test(name)
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function symlinkError(path: string): SmartAppPackageValidationError {
  return new SmartAppPackageValidationError(
    'SA-PACKAGE-SYMLINK',
    'Smart app package contains a symbolic link',
    path
  )
}
