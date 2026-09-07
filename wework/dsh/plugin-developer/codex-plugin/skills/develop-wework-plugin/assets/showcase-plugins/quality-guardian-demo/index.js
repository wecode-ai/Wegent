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

  const commands = await buildTestCommands(root, selected)
  const startedAt = Date.now()
  const results = []
  for (const command of commands) {
    results.push(await executeTestCommand(root, command))
  }
  return {
    id: `run-${startedAt}`,
    state: aggregateRunState(results),
    durationMs: Date.now() - startedAt,
    command: results.map(result => result.command).join('\n'),
    output: results
      .map(result => `$ ${result.command}\n${result.output}`.trim())
      .join('\n\n')
      .slice(-30_000),
    testIds: selected.map(test => test.id),
  }
}

export async function buildTestCommands(root, selected) {
  const groups = {
    javascript: selected.filter(
      test => test.framework === 'Spec runner' || test.framework === 'Test runner'
    ),
    go: selected.filter(test => test.framework === 'Go test'),
    python: selected.filter(test => test.framework === 'Pytest'),
  }
  const commands = []
  if (groups.python.length > 0) {
    commands.push({
      file: 'python3',
      args: ['-m', 'pytest', '-q', ...groups.python.map(test => test.path)],
    })
  }
  if (groups.go.length > 0) {
    const packages = [...new Set(groups.go.map(test => `./${dirname(test.path)}`))]
    commands.push({ file: 'go', args: ['test', ...packages] })
  }
  if (groups.javascript.length > 0) {
    const manifest = await readJson(join(root, 'package.json'))
    if (!manifest?.scripts?.test) {
      throw new Error('未找到可运行 JavaScript 测试的 package.json test 脚本')
    }
    const runner = await packageRunner(root)
    commands.push({
      file: runner,
      args: ['test', '--', '--run', ...groups.javascript.map(test => test.path)],
    })
  }
  return commands
}

async function executeTestCommand(root, command) {
  const displayCommand = [command.file, ...command.args].join(' ')
  try {
    const { stdout, stderr } = await execFileAsync(command.file, command.args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    })
    return {
      command: displayCommand,
      output: `${stdout}${stderr}`.trim(),
      state: 'passed',
    }
  } catch (error) {
    return {
      command: displayCommand,
      output: `${error?.stdout ?? ''}${error?.stderr ?? error?.message ?? ''}`.trim(),
      state: error?.killed ? 'cancelled' : 'failed',
    }
  }
}

function aggregateRunState(results) {
  if (results.some(result => result.state === 'failed')) return 'failed'
  if (results.some(result => result.state === 'cancelled')) return 'cancelled'
  return 'passed'
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
