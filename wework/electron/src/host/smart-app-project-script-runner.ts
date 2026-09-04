import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  resolveWorkbenchProjectPnpmCommand,
  type WorkbenchProjectPnpmCommand,
} from '../runtime/workbench-dsh-runtime.js'
import type { SmartAppVerificationIssue } from './smart-app-verification-types.js'

const SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const SCRIPT_ORDER = ['typecheck', 'test', 'build'] as const
const SAFE_ENVIRONMENT_KEYS = new Set([
  'CI',
  'COMSPEC',
  'ELECTRON_RUN_AS_NODE',
  'FORCE_COLOR',
  'LANG',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WEWORK_NODE_RUNTIME_KIND',
  'WEWORK_RUNTIME_BIN',
])

export type SmartAppProjectScriptKey = (typeof SCRIPT_ORDER)[number]

export interface SmartAppProjectScripts {
  typecheck: string
  test: string
  build: string
}

export interface SmartAppProjectScriptResult {
  key: SmartAppProjectScriptKey
  script: string
  status: 'passed' | 'failed'
  exitCode: number | null
  logPath: string
}

export interface SmartAppProjectScriptsResult {
  scripts: SmartAppProjectScriptResult[]
  issues: SmartAppVerificationIssue[]
}

export interface SmartAppScriptCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type SmartAppScriptCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false }
) => Promise<SmartAppScriptCommandResult>

export interface RunSmartAppProjectScriptsOptions {
  projectRoot: string
  runtimeRoot: string
  environment: NodeJS.ProcessEnv
  scripts: SmartAppProjectScripts
  resolveCommand?: (options: {
    runtimeRoot: string
    environment: NodeJS.ProcessEnv
  }) => Promise<WorkbenchProjectPnpmCommand>
  run?: SmartAppScriptCommandRunner
}

export interface RunSmartAppRuntimeProbeOptions extends Omit<
  RunSmartAppProjectScriptsOptions,
  'scripts'
> {
  script: string
  baseUrl: string
}

export async function runSmartAppProjectScripts(
  options: RunSmartAppProjectScriptsOptions
): Promise<SmartAppProjectScriptsResult> {
  for (const key of SCRIPT_ORDER) {
    if (!SCRIPT_NAME.test(options.scripts[key])) {
      return { scripts: [], issues: [invalidScriptIssue(key, options.scripts[key])] }
    }
  }
  const resolveCommand = options.resolveCommand ?? resolveWorkbenchProjectPnpmCommand
  const command = await resolveCommand({
    runtimeRoot: options.runtimeRoot,
    environment: options.environment,
  })
  const environment = sanitizedEnvironment(command.environment)
  const run = options.run ?? runCommand
  const logsDirectory = join(options.projectRoot, 'test-results', 'smart-app', 'logs')
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 })
  const scripts: SmartAppProjectScriptResult[] = []
  for (const key of SCRIPT_ORDER) {
    const script = options.scripts[key]
    const result = await run(command.command, [...command.argsPrefix, 'run', script], {
      cwd: options.projectRoot,
      env: environment,
      shell: false,
    })
    const log = join(logsDirectory, `${key}.log`)
    await writeFile(log, scriptLog(command.command, script, result), { mode: 0o600 })
    const logPath = relative(options.projectRoot, log).split(sep).join('/')
    const status = result.exitCode === 0 ? 'passed' : 'failed'
    scripts.push({ key, script, status, exitCode: result.exitCode, logPath })
    if (status === 'failed') {
      return { scripts, issues: [failedScriptIssue(key, result.exitCode, logPath)] }
    }
  }
  return { scripts, issues: [] }
}

export async function runSmartAppRuntimeProbe(
  options: RunSmartAppRuntimeProbeOptions
): Promise<{ issues: SmartAppVerificationIssue[] }> {
  if (!SCRIPT_NAME.test(options.script)) {
    return {
      issues: [
        {
          ...invalidScriptIssue('test', options.script),
          code: 'SA-RUNTIME-PROBE-NAME',
          stage: 'runtime',
          message: 'The runtime probe script name is invalid',
        },
      ],
    }
  }
  const resolveCommand = options.resolveCommand ?? resolveWorkbenchProjectPnpmCommand
  const command = await resolveCommand({
    runtimeRoot: options.runtimeRoot,
    environment: options.environment,
  })
  const environment = {
    ...sanitizedEnvironment(command.environment),
    SMART_APP_BASE_URL: options.baseUrl,
  }
  const run = options.run ?? runCommand
  const result = await run(command.command, [...command.argsPrefix, 'run', options.script], {
    cwd: options.projectRoot,
    env: environment,
    shell: false,
  })
  const log = join(options.projectRoot, 'test-results', 'smart-app', 'logs', 'runtime-probe.log')
  await mkdir(join(log, '..'), { recursive: true, mode: 0o700 })
  await writeFile(log, scriptLog(command.command, options.script, result), { mode: 0o600 })
  if (result.exitCode === 0) return { issues: [] }
  return {
    issues: [
      {
        code: 'SA-RUNTIME-PROBE',
        stage: 'runtime',
        file: relative(options.projectRoot, log).split(sep).join('/'),
        message: 'Smart App runtime probe failed',
        expected: 'exit code 0',
        actual: result.exitCode === null ? 'spawn error' : `exit code ${result.exitCode}`,
        blocking: true,
        hint: 'Inspect the runtime probe log',
      },
    ],
  }
}

function sanitizedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined &&
        (SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase()) || key.startsWith('LC_'))
    )
  )
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false }
): Promise<SmartAppScriptCommandResult> {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout = appendLimited(stdout, String(chunk))
    })
    child.stderr.on('data', chunk => {
      stderr = appendLimited(stderr, String(chunk))
    })
    child.once('error', error => {
      resolvePromise({ exitCode: null, stdout, stderr: appendLimited(stderr, error.message) })
    })
    child.once('exit', exitCode => resolvePromise({ exitCode, stdout, stderr }))
  })
}

function appendLimited(current: string, chunk: string): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) return current
  const combined = current + chunk
  if (Buffer.byteLength(combined) <= MAX_CAPTURE_BYTES) return combined
  return `${Buffer.from(combined).subarray(0, MAX_CAPTURE_BYTES).toString()}\n[output truncated]\n`
}

function scriptLog(command: string, script: string, result: SmartAppScriptCommandResult): string {
  return [
    `Command: ${command} run ${script}`,
    `Exit: ${result.exitCode ?? 'spawn-error'}`,
    '',
    'stdout:',
    result.stdout,
    '',
    'stderr:',
    result.stderr,
    '',
  ].join('\n')
}

function invalidScriptIssue(
  key: SmartAppProjectScriptKey,
  actual: string
): SmartAppVerificationIssue {
  return {
    code: 'SA-SCRIPTS-NAME',
    stage: 'scripts',
    file: 'smart-app.verify.json',
    message: `The ${key} script name is invalid`,
    expected: 'A package script name',
    actual,
    blocking: true,
    hint: null,
  }
}

function failedScriptIssue(
  key: SmartAppProjectScriptKey,
  exitCode: number | null,
  logPath: string
): SmartAppVerificationIssue {
  return {
    code: `SA-SCRIPTS-${key.toUpperCase()}`,
    stage: 'scripts',
    file: logPath,
    message: `Smart App ${key} script failed`,
    expected: 'exit code 0',
    actual: exitCode === null ? 'spawn error' : `exit code ${exitCode}`,
    blocking: true,
    hint: `Inspect ${logPath}`,
  }
}
