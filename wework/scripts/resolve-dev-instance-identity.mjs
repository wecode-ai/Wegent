import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TASK_TITLE_MAX_CHARACTERS = 18
const EXECUTABLE_NAME_MAX_CHARACTERS = 80

function normalizeSingleLine(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
}

function truncateCharacters(value, maximum) {
  const characters = Array.from(value)
  if (characters.length <= maximum) return value
  return `${characters.slice(0, maximum).join('')}…`
}

function stableId(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function runtimeTaskIdFromWorkspace(workspacePath) {
  const segments = workspacePath.split(/[\\/]+/).filter(Boolean)
  return segments.findLast(segment => /^runtime-.+$/.test(segment)) ?? null
}

function runtimeInstanceLabel(workspacePath, fallbackId) {
  return runtimeTaskIdFromWorkspace(workspacePath)?.slice('runtime-'.length) || fallbackId
}

function executableName(dockTitle) {
  const sanitized = dockTitle.replace(/[/:]+/g, '-').trim() || 'Wework Dev'
  return Array.from(sanitized).slice(0, EXECUTABLE_NAME_MAX_CHARACTERS).join('')
}

export function findPersistedRuntimeTaskTitle(index, workspacePath) {
  const runtimeTaskId = runtimeTaskIdFromWorkspace(resolve(workspacePath))
  if (!runtimeTaskId) return null

  const task = index?.tasks?.[runtimeTaskId]
  if (!task || task.archived === true || task.status === 'archived') return null
  return normalizeSingleLine(task.title) || null
}

export async function resolveDevTaskTitle(
  environment = process.env,
  { runtimeIndexPath, workspacePath = '' } = {}
) {
  const inheritedTitle = normalizeSingleLine(environment.WEWORK_PARENT_TITLE)
  if (inheritedTitle) return inheritedTitle
  if (!workspacePath) return null

  const executorHome =
    environment.WEGENT_EXECUTOR_HOME?.trim() ||
    join(environment.HOME?.trim() || homedir(), '.wework')
  const indexPath = runtimeIndexPath || join(executorHome, 'runtime-work', 'index.json')
  try {
    const index = JSON.parse(await readFile(indexPath, 'utf8'))
    return findPersistedRuntimeTaskTitle(index, workspacePath)
  } catch {
    return null
  }
}

export function buildDevInstanceIdentity({ workspacePath, branch = '', taskTitle = '' }) {
  const resolvedWorkspacePath = resolve(workspacePath)
  const projectName = normalizeSingleLine(basename(resolvedWorkspacePath))
  const normalizedBranch = normalizeSingleLine(branch)
  const normalizedTaskTitle = normalizeSingleLine(taskTitle)
  const title = normalizedTaskTitle
    ? truncateCharacters(normalizedTaskTitle, TASK_TITLE_MAX_CHARACTERS)
    : normalizedBranch
      ? `${projectName} · ${normalizedBranch}`
      : projectName
  const instanceId = stableId(resolvedWorkspacePath)
  const instanceLabel = runtimeInstanceLabel(resolvedWorkspacePath, instanceId)
  const badge = Array.from(instanceLabel).slice(0, 4).join('')
  const dockTitle = `${title} · ${badge}`

  return {
    dockTitle,
    executableName: executableName(dockTitle),
    instanceId,
    instanceLabel,
    title,
  }
}

export async function resolveDevInstanceIdentity(
  environment = process.env,
  { runtimeIndexPath, workspacePath = '', branch = '' } = {}
) {
  const taskTitle = await resolveDevTaskTitle(environment, {
    runtimeIndexPath,
    workspacePath,
  })
  return {
    parentTitle: taskTitle ?? '',
    ...buildDevInstanceIdentity({
      branch,
      taskTitle: taskTitle ?? '',
      workspacePath,
    }),
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const workspacePath = process.argv[2]
  if (!workspacePath) {
    console.error('Usage: node resolve-dev-instance-identity.mjs <workspace-path> [git-branch]')
    process.exit(1)
  }

  const identity = await resolveDevInstanceIdentity(process.env, {
    branch: process.argv[3] ?? '',
    workspacePath,
  })
  process.stdout.write(
    [
      identity.parentTitle,
      identity.title,
      identity.instanceId,
      identity.instanceLabel,
      identity.dockTitle,
      identity.executableName,
    ].join('\n')
  )
}
