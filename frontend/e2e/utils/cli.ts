import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface CliJsonEnvelope<T = unknown> {
  success: boolean
  data: T
  error?: {
    code: string
    message: string
    details: Record<string, unknown>
  }
}

export interface RunWegentCliOptions {
  token?: string
  apiKey?: string
  server?: string
  stdin?: string
  timeoutMs?: number
  homeDir?: string
  pythonExecutable?: string
  env?: NodeJS.ProcessEnv
}

export interface CliTeamResource {
  apiVersion: 'agent.wecode.io/v1'
  kind: 'Team'
  metadata: {
    name: string
    namespace: string
    displayName: string
  }
  spec: {
    description: string
    collaborationModel: 'collaborate'
    members: []
    bind_mode: string[]
  }
}

const DEFAULT_TIMEOUT_MS = 30000

export function buildCliTeamResource(name: string): CliTeamResource {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'Team',
    metadata: {
      name,
      namespace: 'default',
      displayName: name,
    },
    spec: {
      description: `E2E CLI-created team ${name}`,
      collaborationModel: 'collaborate',
      members: [],
      bind_mode: ['chat'],
    },
  }
}

export function parseCliJson<T = unknown>(result: CliResult): CliJsonEnvelope<T> {
  const output = result.stdout.trim() || result.stderr.trim()
  if (!output) {
    throw new Error(`CLI did not emit JSON. exit=${result.exitCode}`)
  }

  try {
    return JSON.parse(output) as CliJsonEnvelope<T>
  } catch (error) {
    throw new Error(
      `Failed to parse CLI JSON. exit=${result.exitCode} stdout=${result.stdout} stderr=${
        result.stderr
      } error=${String(error)}`
    )
  }
}

export async function runWegentCli(
  args: string[],
  options: RunWegentCliOptions = {}
): Promise<CliResult> {
  const cliRoot = path.resolve(__dirname, '../../../wegent-cli')
  const ownsHomeDir = !options.homeDir
  const homeDir = options.homeDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'wegent-cli-e2e-')))

  try {
    return await spawnWegentCli(args, {
      ...options,
      homeDir,
      cliRoot,
    })
  } finally {
    if (ownsHomeDir) {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  }
}

async function spawnWegentCli(
  args: string[],
  options: RunWegentCliOptions & { homeDir: string; cliRoot: string }
): Promise<CliResult> {
  const python = options.pythonExecutable ?? process.env.E2E_WEGENT_CLI_PYTHON ?? 'python'
  const server = options.server ?? process.env.E2E_API_URL ?? 'http://localhost:8000'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    HOME: options.homeDir,
    PYTHONUNBUFFERED: '1',
    WEGENT_SERVER: server,
  }

  if (options.token !== undefined) {
    env.WEGENT_TOKEN = options.token
  }
  if (options.apiKey !== undefined) {
    env.WEGENT_API_KEY = options.apiKey
  }

  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(python, ['-m', 'wegent.cli', ...args], {
      cwd: options.cliRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new Error(
          `CLI timed out after ${timeoutMs}ms. args=${args.join(' ')} stdout=${stdout} stderr=${stderr}`
        )
      )
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timeout)
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      })
    })

    if (options.stdin) {
      child.stdin.write(options.stdin)
    }
    child.stdin.end()
  })
}
