import { ZipArchive } from 'archiver'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp } from 'node:fs/promises'
import { mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import extractZip from 'extract-zip'
import semver from 'semver'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import type { SmartAppVerificationIssue } from './smart-app-verification-types.js'

export const MAX_SMART_APP_ARCHIVE_BYTES = 50 * 1024 * 1024
export const MAX_SMART_APP_EXTRACTED_BYTES = 250 * 1024 * 1024

export interface SmartAppPackageValidationOptions {
  maxArchiveBytes?: number
  maxExtractedBytes?: number
  developmentSource?: boolean
}

export interface ValidatedSmartAppPackage {
  path: string
  manifest: WorkbenchAppManifest
  sha256: string
}

export class SmartAppPackageValidationError extends Error {
  readonly issue: SmartAppVerificationIssue

  constructor(
    readonly code: string,
    message: string,
    file: string | null = null
  ) {
    super(message)
    this.name = 'SmartAppPackageValidationError'
    this.issue = {
      code,
      stage: code.startsWith('SA-MANIFEST-') ? 'manifest' : 'package',
      file,
      message,
      expected: null,
      actual: null,
      blocking: true,
      hint: null,
    }
  }
}

export async function validateSmartAppPackageDirectory(
  directoryPath: string,
  options: SmartAppPackageValidationOptions = {}
): Promise<ValidatedSmartAppPackage> {
  const path = await requiredSmartAppDirectory(directoryPath, 'Smart app package')
  const manifest = await readManifestFile(join(path, 'plugin-manifest.json'))
  validateSmartAppManifest(manifest)
  await validateDeclaredPaths(path, manifest)
  const files = await packageFiles(path, options.developmentSource === true)
  const maxBytes = options.maxExtractedBytes ?? MAX_SMART_APP_EXTRACTED_BYTES
  const hash = createHash('sha256')
  let totalBytes = 0
  for (const filePath of files) {
    const bytes = await readFile(filePath)
    totalBytes += bytes.byteLength
    if (totalBytes > maxBytes) {
      throw validationError('SA-PACKAGE-EXTRACTED-SIZE', 'Smart app directory exceeds 250 MB')
    }
    hash.update(relative(path, filePath).split(sep).join('/'))
    hash.update('\0')
    hash.update(bytes)
  }
  return { path, manifest, sha256: hash.digest('hex') }
}

export function validateSmartAppManifest(value: unknown): WorkbenchAppManifest {
  const manifest = value as WorkbenchAppManifest
  if (!manifest || typeof manifest !== 'object') {
    throw validationError('SA-MANIFEST-SHAPE', 'Smart app manifest must be an object')
  }
  if (manifest.type !== 'deepseek-harness-plugin-bundle') {
    throw validationError('SA-MANIFEST-TYPE', 'Unsupported Smart app package type')
  }
  if (!semver.valid(manifest.version)) {
    throw validationError('SA-MANIFEST-VERSION', 'Smart app version is invalid')
  }
  validateManifestIdentity(manifest)
  validateRuntimeRequirements(manifest)
  validatePackageDeclarations(manifest)
  validatePluginDeclarations(manifest)
  return manifest
}

export async function extractSmartAppArchive(
  archivePath: string,
  destination: string,
  options: SmartAppPackageValidationOptions = {}
): Promise<void> {
  const metadata = await stat(archivePath)
  const maxArchiveBytes = options.maxArchiveBytes ?? MAX_SMART_APP_ARCHIVE_BYTES
  if (metadata.size > maxArchiveBytes) {
    throw validationError('SA-PACKAGE-ARCHIVE-SIZE', 'Smart app ZIP exceeds 50 MB')
  }
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const maxExtractedBytes = options.maxExtractedBytes ?? MAX_SMART_APP_EXTRACTED_BYTES
  let extractedBytes = 0
  await extractZip(archivePath, {
    dir: resolve(destination),
    onEntry: entry => {
      extractedBytes += entry.uncompressedSize
      if (extractedBytes > maxExtractedBytes) {
        throw validationError('SA-PACKAGE-EXTRACTED-SIZE', 'Smart app ZIP expands beyond 250 MB')
      }
    },
  })
}

export async function readSmartAppManifest(root: string): Promise<WorkbenchAppManifest> {
  const manifestRoot = await findSmartAppManifestRoot(root)
  return readManifestFile(join(manifestRoot, 'plugin-manifest.json'))
}

export async function findSmartAppManifestRoot(root: string): Promise<string> {
  const matches = (await packageFiles(root)).filter(
    path => basename(path) === 'plugin-manifest.json'
  )
  if (matches.length !== 1) {
    throw validationError(
      'SA-PACKAGE-MANIFEST-COUNT',
      matches.length
        ? 'Smart app ZIP contains multiple plugin-manifest.json files'
        : 'plugin-manifest.json is missing'
    )
  }
  const manifestRoot = dirname(matches[0] as string)
  const depth = relative(resolve(root), manifestRoot).split(sep).filter(Boolean).length
  if (depth > 1) {
    throw validationError(
      'SA-PACKAGE-MANIFEST-ROOT',
      'Smart app manifest must be at the ZIP root or inside one wrapper directory'
    )
  }
  return manifestRoot
}

export async function copySmartAppDirectorySafe(
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  const source = await requiredSmartAppDirectory(sourcePath, 'Source')
  await mkdir(destinationPath, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw symlinkError(join(source, entry.name))
    const sourceEntry = join(source, entry.name)
    const destinationEntry = join(destinationPath, entry.name)
    if (entry.isDirectory()) await copySmartAppDirectorySafe(sourceEntry, destinationEntry)
    else if (entry.isFile()) await cp(sourceEntry, destinationEntry)
  }
}

export async function listSmartAppDeliveryFiles(directoryPath: string): Promise<string[]> {
  const root = await requiredSmartAppDirectory(directoryPath, 'Smart app project')
  const files: string[] = []
  await walkPackage(root, path => files.push(relative(root, path).split(sep).join('/')), true, true)
  return files.sort()
}

export async function archiveSmartAppDelivery(
  directoryPath: string,
  destinationPath: string
): Promise<void> {
  const root = await requiredSmartAppDirectory(directoryPath, 'Smart app project')
  const files = await listSmartAppDeliveryFiles(root)
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(destinationPath, { mode: 0o600 })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolvePromise)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    for (const file of files) archive.file(join(root, file), { name: file })
    void archive.finalize()
  })
}

export async function copySmartAppDeliveryFiles(
  directoryPath: string,
  destinationPath: string
): Promise<void> {
  const root = await requiredSmartAppDirectory(directoryPath, 'Smart app project')
  const files = await listSmartAppDeliveryFiles(root)
  await mkdir(destinationPath, { recursive: true, mode: 0o700 })
  for (const file of files) {
    const destination = join(destinationPath, file)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await cp(join(root, file), destination)
  }
}

export async function requiredSmartAppDirectory(path: string, label: string): Promise<string> {
  const resolved = await realpath(path.trim()).catch(error => {
    throw validationError(
      'SA-MANIFEST-PATH-MISSING',
      `Failed to resolve ${label} directory: ${String(error)}`,
      path
    )
  })
  if (!(await stat(resolved)).isDirectory()) {
    throw validationError('SA-MANIFEST-PATH-MISSING', `${label} path must be a directory`, path)
  }
  return resolved
}

export function isSafeSmartAppRelativePath(value: string): boolean {
  const path = value?.trim()
  if (!path || isAbsolute(path)) return false
  const normalized = normalize(path)
  return (
    normalized !== '.' &&
    normalized !== '..' &&
    !normalized.startsWith(`..${sep}`) &&
    !normalized.includes('\0')
  )
}

function validateManifestIdentity(manifest: WorkbenchAppManifest): void {
  if (
    !manifest.name?.trim() ||
    !/^[0-9A-Za-z_-]+$/.test(manifest.name) ||
    !manifest.entry?.profile?.trim() ||
    !isSafeSmartAppRelativePath(manifest.entry.installPackage)
  ) {
    throw validationError(
      'SA-MANIFEST-ENTRY',
      'Smart app manifest has incomplete identity or entry fields'
    )
  }
}

function validateRuntimeRequirements(manifest: WorkbenchAppManifest): void {
  if (
    !manifest.requirements?.dsh ||
    !semver.validRange(manifest.requirements.dsh, { includePrerelease: true }) ||
    !manifest.requirements.node ||
    !semver.validRange(manifest.requirements.node, { includePrerelease: true })
  ) {
    throw validationError('SA-MANIFEST-REQUIREMENTS', 'Smart app runtime requirements are invalid')
  }
}

function validatePackageDeclarations(manifest: WorkbenchAppManifest): void {
  const packages = manifest.packages ?? []
  const names = new Set<string>()
  const paths = new Set<string>()
  const profileBundles: string[] = []
  for (const item of packages) {
    if (
      !item.name?.trim() ||
      !item.role?.trim() ||
      !isSafeSmartAppRelativePath(item.path) ||
      names.has(item.name) ||
      paths.has(item.path)
    ) {
      throw validationError('SA-MANIFEST-PACKAGE', 'Smart app package declaration is invalid')
    }
    names.add(item.name)
    paths.add(item.path)
    if (item.role === 'profile-bundle') profileBundles.push(item.path)
  }
  if (
    packages.length > 0 &&
    (profileBundles.length !== 1 || profileBundles[0] !== manifest.entry.installPackage)
  ) {
    throw validationError(
      'SA-MANIFEST-PROFILE-BUNDLE',
      'Smart app must declare installPackage as its only profile-bundle'
    )
  }
}

function validatePluginDeclarations(manifest: WorkbenchAppManifest): void {
  const pluginSpecs = new Set<string>()
  for (const plugin of manifest.plugins ?? []) {
    const spec = plugin.spec?.trim()
    if (!spec || spec.startsWith('-') || pluginSpecs.has(spec)) {
      throw validationError('SA-MANIFEST-PLUGIN', 'Smart app plugin declaration is invalid')
    }
    if (
      plugin.path &&
      (!isSafeSmartAppRelativePath(plugin.path) || spec !== `file:${plugin.path}`)
    ) {
      throw validationError(
        'SA-MANIFEST-LOCAL-PLUGIN',
        'Smart app local plugin declaration is invalid'
      )
    }
    pluginSpecs.add(spec)
  }
}

async function validateDeclaredPaths(root: string, manifest: WorkbenchAppManifest): Promise<void> {
  const packagePaths = new Set([
    manifest.entry.installPackage,
    ...(manifest.packages ?? []).map(item => item.path),
  ])
  for (const path of packagePaths) {
    await requiredSmartAppDirectory(join(root, path), 'Declared Smart app package')
  }
  for (const plugin of manifest.plugins ?? []) {
    if (plugin.path) await requiredSmartAppDirectory(join(root, plugin.path), 'Local DSH plugin')
  }
}

async function packageFiles(root: string, developmentSource = false): Promise<string[]> {
  const files: string[] = []
  await walkPackage(root, path => files.push(path), developmentSource, false)
  return files.sort()
}

async function walkPackage(
  root: string,
  visit: (path: string) => void,
  developmentSource = false,
  delivery = false
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) throw symlinkError(path)
    if (entry.isDirectory()) {
      if (developmentSource && isOperationalDirectory(entry.name)) continue
      await walkPackage(path, visit, developmentSource, delivery)
    } else if (entry.isFile()) {
      if (isSensitiveFilename(entry.name)) {
        if (developmentSource) continue
        throw validationError(
          'SA-PACKAGE-SENSITIVE-FILE',
          `Smart app package contains a sensitive file: ${entry.name}`,
          path
        )
      }
      if (delivery && isDevelopmentOnlyFile(entry.name)) continue
      visit(path)
    }
  }
}

function isOperationalDirectory(name: string): boolean {
  return name === '.git' || name === 'node_modules' || name === 'test-results'
}

function isDevelopmentOnlyFile(name: string): boolean {
  return name === 'smart-app.verify.json' || /\.zip$/i.test(name)
}

function isSensitiveFilename(filename: string): boolean {
  return filename === '.env' || filename.startsWith('.env.') || /\.(?:pem|key)$/i.test(filename)
}

async function readManifestFile(path: string): Promise<WorkbenchAppManifest> {
  try {
    return validateSmartAppManifest(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error instanceof SmartAppPackageValidationError) throw error
    throw validationError('SA-MANIFEST-JSON', 'plugin-manifest.json is invalid', path)
  }
}

function symlinkError(path: string): SmartAppPackageValidationError {
  return validationError('SA-PACKAGE-SYMLINK', 'Smart app package contains a symbolic link', path)
}

function validationError(
  code: string,
  message: string,
  file: string | null = null
): SmartAppPackageValidationError {
  return new SmartAppPackageValidationError(code, message, file)
}
