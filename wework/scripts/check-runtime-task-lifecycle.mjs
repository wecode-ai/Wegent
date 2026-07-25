import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'src')
const lifecycleRoot = path.join(sourceRoot, 'features', 'workbench', 'runtimeTaskLifecycle')

const forbiddenIdentifiers = [
  'activeRuntimeTasks',
  'authoritativeRuntimeTaskRunning',
  'currentRuntimeTaskRunning',
  'ongoingTaskKeys',
  'pendingSettledRuntimeTasks',
  'providerRunning',
  'runtime_task_started',
  'runtime_task_settled',
  'runtimeTaskStatus',
  'setSendPhase',
]

const rawRunningPattern = /\b(?:task|runtimeTask|summary|transcript)\.running\b/
const rawRunningAllowedFiles = new Set([
  path.join(lifecycleRoot, 'reducer.ts'),
  path.join(lifecycleRoot, 'RuntimeTaskLifecycleStore.ts'),
  path.join(sourceRoot, 'features', 'workbench', 'useWorkbenchRuntimeTasks.ts'),
])

const files = await collectSourceFiles(sourceRoot)
const violations = []

for (const file of files) {
  const source = await readFile(file, 'utf8')
  const relative = path.relative(root, file)
  const lines = source.split('\n')

  for (const identifier of forbiddenIdentifiers) {
    addLineViolations(file, relative, lines, new RegExp(`\\b${identifier}\\b`, 'g'), violations)
  }

  if (!rawRunningAllowedFiles.has(file)) {
    addLineViolations(file, relative, lines, rawRunningPattern, violations)
  }

  if (
    file !== path.join(lifecycleRoot, 'reducer.ts') &&
    file !== path.join(lifecycleRoot, 'RuntimeTaskMachine.ts')
  ) {
    addLineViolations(file, relative, lines, /\breduceRuntimeTaskLifecycle\b/, violations)
  }
}

if (violations.length > 0) {
  console.error(
    [
      'Runtime task lifecycle boundary check failed.',
      'Task execution, turn, and unread state must be interpreted only by runtimeTaskLifecycle.',
      ...violations.map(violation => `- ${violation}`),
    ].join('\n')
  )
  process.exitCode = 1
} else {
  console.log(
    `Runtime task lifecycle boundary check passed (${files.length} source files checked).`
  )
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(entry => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return collectSourceFiles(entryPath)
      return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : []
    })
  )
  return nested.flat()
}

function addLineViolations(file, relative, lines, pattern, target) {
  lines.forEach((line, index) => {
    pattern.lastIndex = 0
    if (!pattern.test(line)) return
    target.push(`${relative}:${index + 1}: ${line.trim()}`)
  })
}
