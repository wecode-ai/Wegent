import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'test-explorer-demo'
export const inject = ['weworkPluginRuntime']

const IGNORED = new Set([
  '.git',
  '.next',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'target',
])

export function apply(ctx) {
  ctx.weworkPluginRuntime.register(ctx, {
    id: 'test-explorer',
    methods: {
      discover: discoverTests,
      run: runTests,
    },
  })
}

export async function discoverTests({ cwd }) {
  const root = await requiredWorkspace(cwd)
  const files = await collectTestFiles(root)
  const tests = files.map(path => {
    const relativePath = relative(root, path)
    return {
      id: relativePath,
      label: basename(path),
      path: relativePath,
      group: dirname(relativePath) === '.' ? 'root' : dirname(relativePath),
      framework: frameworkFor(path),
      state: 'idle',
    }
  })
  return {
    path: root,
    count: tests.length,
    frameworks: [...new Set(tests.map(test => test.framework))],
    tests,
  }
}

export async function runTests({ cwd, testIds = [] }) {
  const root = await requiredWorkspace(cwd)
  const discovered = await discoverTests({ cwd: root })
  const selected = discovered.tests.filter(
    test => testIds.length === 0 || testIds.includes(test.id)
  )
  if (selected.length === 0) throw new Error('没有可运行的测试')

  const command = await testCommand(root, selected)
  const startedAt = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(command.file, command.args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    })
    return {
      id: `run-${startedAt}`,
      state: 'passed',
      durationMs: Date.now() - startedAt,
      command: [command.file, ...command.args].join(' '),
      output: `${stdout}${stderr}`.trim().slice(-30_000),
      testIds: selected.map(test => test.id),
    }
  } catch (error) {
    return {
      id: `run-${startedAt}`,
      state: error?.killed ? 'cancelled' : 'failed',
      durationMs: Date.now() - startedAt,
      command: [command.file, ...command.args].join(' '),
      output: `${error?.stdout ?? ''}${error?.stderr ?? error?.message ?? ''}`
        .trim()
        .slice(-30_000),
      testIds: selected.map(test => test.id),
    }
  }
}

async function testCommand(root, selected) {
  const paths = selected.map(test => test.path)
  const frameworks = new Set(selected.map(test => test.framework))
  if ([...frameworks].every(framework => framework === 'Pytest')) {
    return { file: 'python3', args: ['-m', 'pytest', '-q', ...paths] }
  }
  if ([...frameworks].every(framework => framework === 'Go test')) {
    const packages = [...new Set(paths.map(path => `./${dirname(path)}`))]
    return { file: 'go', args: ['test', ...packages] }
  }

  const manifest = await readJson(join(root, 'package.json'))
  if (!manifest?.scripts?.test) {
    throw new Error('未找到可运行这些测试的 package.json test 脚本')
  }
  const runner = await packageRunner(root)
  return { file: runner, args: ['test', '--', '--run', ...paths] }
}

async function packageRunner(root) {
  for (const [lockfile, runner] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ]) {
    try {
      await stat(join(root, lockfile))
      return runner
    } catch {
      // Continue to the next package manager marker.
    }
  }
  return 'npm'
}

function frameworkFor(path) {
  const name = basename(path).toLowerCase()
  if (name.startsWith('test_') || name.endsWith('_test.py')) return 'Pytest'
  if (name.endsWith('_test.go')) return 'Go test'
  if (name.includes('.spec.')) return 'Spec runner'
  return 'Test runner'
}

function isTestFile(name) {
  const lower = name.toLowerCase()
  return (
    /^test_.*\.py$/.test(lower) ||
    /_test\.(?:py|go)$/.test(lower) ||
    /\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(lower)
  )
}

async function requiredWorkspace(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('Workspace path must be absolute')
  }
  const info = await stat(value)
  if (!info.isDirectory()) throw new Error('Workspace path must be a directory')
  return value
}

async function collectTestFiles(root) {
  const files = []
  const directories = [{ path: root, depth: 0 }]
  while (directories.length > 0 && files.length < 500) {
    const directory = directories.shift()
    if (!directory || directory.depth > 8) continue
    let entries
    try {
      entries = await readdir(directory.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= 500) break
      const path = join(directory.path, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name) && !entry.name.startsWith('.')) {
          directories.push({ path, depth: directory.depth + 1 })
        }
      } else if (entry.isFile() && isTestFile(entry.name) && extname(entry.name)) {
        files.push(path)
      }
    }
  }
  return files.sort()
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}
