import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, Script } from 'node:vm'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import { runtimeNodeArgs } from '../runtime/electron-node-runtime.js'
import type {
  SmartAppVerificationContract,
  SmartAppVerificationIssue,
} from './smart-app-verification-types.js'

const CLIENT_EXECUTION_TIMEOUT_MS = 1_000

interface BundlePackageManifest {
  name?: unknown
  main?: unknown
  exports?: unknown
  files?: unknown
  dsh?: unknown
}

export interface ValidateSmartAppArtifactsOptions {
  projectRoot: string
  manifest: WorkbenchAppManifest
  contract: SmartAppVerificationContract
  importHost?: (path: string) => Promise<boolean>
}

export interface SmartAppArtifactValidationResult {
  issues: SmartAppVerificationIssue[]
}

export async function validateSmartAppArtifacts(
  options: ValidateSmartAppArtifactsOptions
): Promise<SmartAppArtifactValidationResult> {
  const issues: SmartAppVerificationIssue[] = []
  const bundle = resolve(options.projectRoot, options.manifest.entry.installPackage)
  const packagePath = join(bundle, 'package.json')
  const packageManifest = await readPackageManifest(packagePath, options.projectRoot, issues)
  if (!packageManifest) return { issues }
  const exports = record(packageManifest.exports)
  const files = stringArray(packageManifest.files)
  await validateBundlePatch(packageManifest, bundle, options.projectRoot, files, issues)

  if (options.contract.capabilities.host) {
    const hostTarget = await validateExportTarget({
      exportTarget: exports['.'] ?? packageManifest.main,
      exportName: '.',
      bundle,
      projectRoot: options.projectRoot,
      files,
      missingCode: 'SA-HOST-EXPORT',
      filesCode: 'SA-HOST-FILES',
      issues,
    })
    if (hostTarget) {
      const imported = await (options.importHost ?? importHostInSubprocess)(hostTarget)
      if (!imported) {
        issues.push(
          issue(
            'SA-HOST-IMPORT',
            options.projectRoot,
            hostTarget,
            'Smart App Host entry could not be imported in isolation'
          )
        )
      }
    }
  }

  if (options.contract.capabilities.client) {
    validateClientMetadata(
      packageManifest,
      options.contract.capabilities.remote,
      packagePath,
      options.projectRoot,
      issues
    )
    if (exports['./package.json'] !== './package.json') {
      issues.push(
        issue(
          'SA-CLIENT-PACKAGE-EXPORT',
          options.projectRoot,
          packagePath,
          'Client packages must export ./package.json for DSH discovery'
        )
      )
    }
    const clientTarget = await validateExportTarget({
      exportTarget: exports['./client'],
      exportName: './client',
      bundle,
      projectRoot: options.projectRoot,
      files,
      missingCode: 'SA-CLIENT-EXPORT',
      filesCode: 'SA-CLIENT-FILES',
      issues,
    })
    if (clientTarget) {
      validateClientModule(
        clientTarget,
        options.projectRoot,
        typeof packageManifest.name === 'string' ? packageManifest.name : '',
        issues
      )
    }
  }

  if (options.contract.capabilities.remote) {
    for (const exportName of ['./remote', './typert']) {
      await validateExportTarget({
        exportTarget: exports[exportName],
        exportName,
        bundle,
        projectRoot: options.projectRoot,
        files,
        missingCode: 'SA-REMOTE-EXPORT',
        filesCode: 'SA-REMOTE-FILES',
        issues,
      })
    }
  }
  return { issues }
}

function validateClientMetadata(
  packageManifest: BundlePackageManifest,
  remote: boolean,
  packagePath: string,
  projectRoot: string,
  issues: SmartAppVerificationIssue[]
): void {
  const client = record(record(packageManifest.dsh).client)
  const inject = stringArray(client.inject) ?? []
  const requiredInject = [
    '@deepseek-ai/dsh-client-runtime',
    ...(remote ? ['@deepseek-ai/dsh-api-gateway'] : []),
  ]
  if (client.platform === 'web' && requiredInject.every(name => inject.includes(name))) return
  issues.push(
    issue(
      'SA-CLIENT-METADATA',
      projectRoot,
      packagePath,
      'Client package metadata does not declare its required DSH modules'
    )
  )
}

async function readPackageManifest(
  path: string,
  projectRoot: string,
  issues: SmartAppVerificationIssue[]
): Promise<BundlePackageManifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!record(value)) throw new Error('not an object')
    return value as BundlePackageManifest
  } catch {
    issues.push(
      issue(
        'SA-PACKAGE-METADATA',
        projectRoot,
        path,
        'Smart App bundle package.json is missing or invalid'
      )
    )
    return null
  }
}

async function validateBundlePatch(
  packageManifest: BundlePackageManifest,
  bundle: string,
  projectRoot: string,
  files: string[] | null,
  issues: SmartAppVerificationIssue[]
): Promise<void> {
  const patch = record(record(packageManifest.dsh).bundle).patch
  const path = await packageTarget(bundle, patch)
  if (!path || !(await isFile(path))) {
    issues.push(
      issue(
        'SA-PACKAGE-BUNDLE-PATCH',
        projectRoot,
        join(bundle, 'package.json'),
        'Smart App bundle patch does not resolve to a file'
      )
    )
    return
  }
  if (!includedInPackage(bundle, path, files)) {
    issues.push(
      issue(
        'SA-PACKAGE-BUNDLE-PATCH-FILES',
        projectRoot,
        path,
        'Smart App bundle patch is excluded by package files'
      )
    )
  }
}

interface ValidateExportTargetOptions {
  exportTarget: unknown
  exportName: string
  bundle: string
  projectRoot: string
  files: string[] | null
  missingCode: string
  filesCode: string
  issues: SmartAppVerificationIssue[]
}

async function validateExportTarget(options: ValidateExportTargetOptions): Promise<string | null> {
  const target = await packageTarget(options.bundle, options.exportTarget)
  if (!target || !(await isFile(target))) {
    options.issues.push(
      issue(
        options.missingCode,
        options.projectRoot,
        join(options.bundle, 'package.json'),
        `Smart App export ${options.exportName} does not resolve to a built file`
      )
    )
    return null
  }
  if (!includedInPackage(options.bundle, target, options.files)) {
    options.issues.push(
      issue(
        options.filesCode,
        options.projectRoot,
        target,
        `Smart App export ${options.exportName} is excluded by package files`
      )
    )
    return null
  }
  return target
}

function validateClientModule(
  path: string,
  projectRoot: string,
  packageName: string,
  issues: SmartAppVerificationIssue[]
): void {
  const registrations: unknown[] = []
  const context = createContext({
    window: {
      __ModuleLoader__: Object.freeze({
        load: (registration: unknown) => registrations.push(registration),
      }),
    },
  })
  try {
    const source = readFileSync(path, 'utf8')
    new Script(source, { filename: relative(projectRoot, path) }).runInContext(context, {
      timeout: CLIENT_EXECUTION_TIMEOUT_MS,
    })
  } catch {
    issues.push(
      issue(
        'SA-CLIENT-MODULE-LOADER',
        projectRoot,
        path,
        'Client output did not execute in the controlled DSH ModuleLoader'
      )
    )
    return
  }
  const registration = record(registrations[0])
  if (
    registrations.length !== 1 ||
    typeof registration.id !== 'string' ||
    !registration.id ||
    typeof registration.factory !== 'function'
  ) {
    issues.push(
      issue(
        'SA-CLIENT-MODULE-LOADER',
        projectRoot,
        path,
        'Client output must register exactly one DSH module factory'
      )
    )
    return
  }
  if (registration.id !== packageName) {
    issues.push(
      issue(
        'SA-CLIENT-MODULE-ID',
        projectRoot,
        path,
        'Client ModuleLoader registration must use the bundle package name'
      )
    )
  }
}

function importHostInSubprocess(path: string): Promise<boolean> {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }
  const command = process.env.WEWORK_NODE_PATH?.trim() || process.execPath
  const source = `import(${JSON.stringify(pathToFileURL(path).href)}).then(() => process.exit(0), () => process.exit(1))`
  const args = runtimeNodeArgs(process.env, ['--input-type=module', '--eval', source])
  return new Promise(resolvePromise => {
    const child = spawn(command, args, {
      env: environment,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    })
    child.once('error', () => resolvePromise(false))
    child.once('exit', code => resolvePromise(code === 0))
  })
}

async function packageTarget(bundle: string, value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !value.startsWith('./') || isAbsolute(value)) return null
  const target = resolve(bundle, value)
  return target.startsWith(`${resolve(bundle)}${sep}`) ? target : null
}

function includedInPackage(bundle: string, path: string, files: string[] | null): boolean {
  if (!files) return true
  const target = relative(bundle, path).split(sep).join('/')
  if (target === 'package.json') return true
  return files.some(value => {
    const entry = value.replace(/^\.\//, '').replace(/\/+$/, '')
    return entry === target || target.startsWith(`${entry}/`)
  })
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null
}

function issue(
  code: string,
  projectRoot: string,
  file: string,
  message: string
): SmartAppVerificationIssue {
  return {
    code,
    stage: 'artifacts',
    file: relative(projectRoot, file).split(sep).join('/'),
    message,
    expected: null,
    actual: null,
    blocking: true,
    hint: null,
  }
}
