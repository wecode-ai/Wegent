import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'dev-environments-demo'
export const inject = ['weworkPluginRuntime']

const TOOLS = [
  { id: 'node', label: 'Node.js', command: 'node', args: ['--version'] },
  { id: 'python', label: 'Python', command: 'python3', args: ['--version'] },
  { id: 'git', label: 'Git', command: 'git', args: ['--version'] },
  { id: 'docker', label: 'Docker', command: 'docker', args: ['--version'] },
]

export function apply(ctx) {
  ctx.weworkPluginRuntime.register(ctx, {
    id: 'dev-environments',
    methods: {
      inspect: inspectEnvironment,
      prepare: prepareEnvironment,
    },
  })
}

export async function inspectEnvironment({ cwd }) {
  const root = await requiredWorkspace(cwd)
  const manifest = await readJson(join(root, 'package.json'))
  const pythonVersion = await readOptional(join(root, '.python-version'))
  const devcontainer = await readJson(join(root, '.devcontainer', 'devcontainer.json'))
  const tools = await Promise.all(TOOLS.map(tool => inspectTool(tool, root)))
  const recommendation = environmentRecommendation({ manifest, pythonVersion })
  return {
    path: root,
    state: devcontainer ? 'configured' : 'local',
    devcontainer,
    recommendation,
    tools,
  }
}

export async function prepareEnvironment({ cwd, target }) {
  const root = await requiredWorkspace(cwd)
  if (target !== 'devcontainer') throw new Error(`Unsupported environment target: ${target}`)
  const current = await inspectEnvironment({ cwd: root })
  const directory = join(root, '.devcontainer')
  const path = join(directory, 'devcontainer.json')
  await mkdir(directory, { recursive: true })
  const configuration = {
    name: 'Wework Development',
    image: current.recommendation.image,
    features: {
      'ghcr.io/devcontainers/features/git:1': {},
    },
    customizations: {
      vscode: {
        extensions: current.recommendation.extensions,
      },
    },
  }
  let created = true
  try {
    await writeFile(path, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    created = false
  }
  return {
    ...(await inspectEnvironment({ cwd: root })),
    created,
    configurationPath: path,
  }
}

function environmentRecommendation({ manifest, pythonVersion }) {
  const dependencies = new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.devDependencies ?? {}),
  ])
  if (pythonVersion) {
    return {
      label: `Python ${pythonVersion}`,
      image: `mcr.microsoft.com/devcontainers/python:1-${pythonVersion}`,
      extensions: ['ms-python.python'],
    }
  }
  if (dependencies.has('typescript') || dependencies.has('react') || manifest) {
    return {
      label: 'Node.js 22',
      image: 'mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm',
      extensions: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'],
    }
  }
  return {
    label: 'Universal Linux',
    image: 'mcr.microsoft.com/devcontainers/base:ubuntu',
    extensions: [],
  }
}

async function inspectTool(tool, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(tool.command, tool.args, {
      cwd,
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    })
    return {
      id: tool.id,
      label: tool.label,
      available: true,
      version: `${stdout}${stderr}`.trim().split(/\r?\n/)[0] || 'available',
    }
  } catch (error) {
    return {
      id: tool.id,
      label: tool.label,
      available: false,
      version: null,
      reason: error?.code === 'ENOENT' ? '未安装或不在 PATH 中' : '检查失败',
    }
  }
}

async function requiredWorkspace(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('Workspace path must be absolute')
  }
  const info = await stat(value)
  if (!info.isDirectory()) throw new Error('Workspace path must be a directory')
  return value
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function readOptional(path) {
  try {
    return (await readFile(path, 'utf8')).trim() || null
  } catch {
    return null
  }
}
