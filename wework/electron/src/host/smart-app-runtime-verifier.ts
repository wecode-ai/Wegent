import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeNodeArgs } from '../runtime/electron-node-runtime.js'
import {
  prepareWorkbenchDshLaunch,
  type PrepareWorkbenchDshOptions,
  type WorkbenchAppManifest,
  type WorkbenchDshLaunch,
} from '../runtime/workbench-dsh-runtime.js'
import { DshRuntime, type DshRuntimeOptions } from '../runtime/dsh-runtime.js'
import type { CommandRunner } from '../runtime/core-dsh-runtime.js'
import { runSmartAppRuntimeProbe } from './smart-app-project-script-runner.js'
import { copySmartAppDeliveryFiles } from './smart-app-package-validator.js'
import {
  verifySmartAppPage,
  type SmartAppVerificationViewResult,
  type VerifySmartAppPageOptions,
} from './smart-app-verification-view.js'
import type {
  SmartAppVerificationContract,
  SmartAppVerificationIssue,
} from './smart-app-verification-types.js'

const SAFE_ENVIRONMENT_KEYS = new Set([
  'COMSPEC',
  'ELECTRON_RUN_AS_NODE',
  'LANG',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WEWORK_NODE_PATH',
  'WEWORK_NODE_RUNTIME_KIND',
  'WEWORK_RUNTIME_BIN',
])

export interface VerifySmartAppRuntimeOptions {
  projectRoot: string
  runtimeRoot: string
  logDirectory: string
  environment: NodeJS.ProcessEnv
  manifest: WorkbenchAppManifest
  contract: SmartAppVerificationContract
  signal?: AbortSignal
}

export interface SmartAppRuntimeHandle {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface SmartAppRuntimeVerifierDependencies {
  prepareLaunch: (options: PrepareWorkbenchDshOptions) => Promise<WorkbenchDshLaunch>
  createRuntime: (options: DshRuntimeOptions) => SmartAppRuntimeHandle
  runCommand: CommandRunner
  verifyPage: (options: VerifySmartAppPageOptions) => Promise<SmartAppVerificationViewResult>
  runProbe: (options: {
    projectRoot: string
    runtimeRoot: string
    environment: NodeJS.ProcessEnv
    script: string
    baseUrl: string
  }) => Promise<{ issues: SmartAppVerificationIssue[] }>
  copyProject: (projectRoot: string, destination: string) => Promise<void>
  reservePort: () => Promise<number>
}

const DEFAULT_DEPENDENCIES: SmartAppRuntimeVerifierDependencies = {
  prepareLaunch: prepareWorkbenchDshLaunch,
  createRuntime: options => new DshRuntime(options),
  runCommand: runRuntimeCommand,
  verifyPage: verifySmartAppPage,
  runProbe: runSmartAppRuntimeProbe,
  copyProject: copySmartAppDeliveryFiles,
  reservePort,
}

export async function verifySmartAppRuntime(
  options: VerifySmartAppRuntimeOptions,
  dependencies: SmartAppRuntimeVerifierDependencies = DEFAULT_DEPENDENCIES
): Promise<{ issues: SmartAppVerificationIssue[] }> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'wework-smart-app-verification-'))
  let runtime: SmartAppRuntimeHandle | null = null
  let stage: 'prepare' | 'config' | 'start' = 'prepare'
  try {
    const home = join(temporaryRoot, 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const installationId = 'verification'
    await createIsolatedCredentials(temporaryRoot, installationId)
    const isolatedProject = join(temporaryRoot, 'project')
    await dependencies.copyProject(options.projectRoot, isolatedProject)
    const environment = isolatedVerificationEnvironment(options.environment, home)
    const port = await dependencies.reservePort()
    const launch = await dependencies.prepareLaunch({
      runtimeRoot: options.runtimeRoot,
      dataDirectory: temporaryRoot,
      installationId,
      packagePath: isolatedProject,
      manifest: options.manifest,
      environment,
      port,
      modelBaseUrl: null,
      contextBaseUrl: null,
      contextToken: null,
      run: dependencies.runCommand,
    })
    stage = 'config'
    await abortable(
      dependencies.runCommand(
        launch.command,
        runtimeNodeArgs(launch.environment, [
          launch.entry,
          '--profile',
          launch.profile,
          '--dump-config',
        ]),
        { cwd: launch.cwd, env: launch.environment }
      ),
      options.signal
    )
    stage = 'start'
    runtime = dependencies.createRuntime({
      name: `dsh-smart-app-verification-${options.manifest.name}`,
      url: launch.url,
      probeUrl: launch.url,
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.environment,
      logDirectory: options.logDirectory,
      logFileName: 'runtime.log',
    })
    await abortable(runtime.start(), options.signal)
    const page = await dependencies.verifyPage({
      baseUrl: launch.url,
      path: options.contract.runtime.path,
      readySelector: options.contract.runtime.readySelector,
      signal: options.signal,
    })
    if (page.issues.length) return page
    if (options.contract.capabilities.remote) {
      const script = options.contract.scripts.runtimeProbe
      if (!script) {
        return {
          issues: [runtimeIssue('SA-RUNTIME-PROBE-MISSING', 'Remote verification has no probe')],
        }
      }
      return dependencies.runProbe({
        projectRoot: isolatedProject,
        runtimeRoot: options.runtimeRoot,
        environment,
        script,
        baseUrl: launch.url,
      })
    }
    return { issues: [] }
  } catch {
    if (options.signal?.aborted) {
      return {
        issues: [runtimeIssue('SA-RUNTIME-CANCELLED', 'Runtime verification was cancelled')],
      }
    }
    const code = {
      prepare: 'SA-RUNTIME-PREPARE',
      config: 'SA-RUNTIME-CONFIG',
      start: 'SA-RUNTIME-START',
    }[stage]
    return { issues: [runtimeIssue(code, `Smart App runtime ${stage} failed`)] }
  } finally {
    await runtime?.stop().catch(() => {})
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function createIsolatedCredentials(
  dataDirectory: string,
  installationId: string
): Promise<void> {
  const dshHome = join(dataDirectory, 'harness-apps', 'instances', installationId)
  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  await writeFile(join(dshHome, '.credentials.yaml'), 'version: "1"\n', { mode: 0o600 })
}

function isolatedVerificationEnvironment(
  environment: NodeJS.ProcessEnv,
  home: string
): NodeJS.ProcessEnv {
  const isolated = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined &&
        (SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase()) || key.startsWith('LC_'))
    )
  )
  return { ...isolated, HOME: home, USERPROFILE: home }
}

function runRuntimeCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`DSH preflight exited with code ${code ?? 'unknown'}`))
    })
  })
}

function reservePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to reserve a loopback port'))
        return
      }
      server.close(error => (error ? reject(error) : resolvePromise(address.port)))
    })
  })
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function runtimeIssue(code: string, message: string): SmartAppVerificationIssue {
  return {
    code,
    stage: 'runtime',
    file: null,
    message,
    expected: null,
    actual: null,
    blocking: true,
    hint: null,
  }
}
