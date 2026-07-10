import type {
  DeviceInfo,
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
} from '@/types/api'
import { supportsGitWorktreeExecution } from '@/lib/projectClassification'

const PROJECT_MENU_VIEWPORT_MARGIN = 16
const PROJECT_MENU_VERTICAL_PADDING = 12
const PROJECT_MENU_SEARCH_BLOCK_HEIGHT = 42
const PROJECT_MENU_ROW_HEIGHT = 36
const PROJECT_MENU_ROW_GAP = 2
const PROJECT_MENU_VISIBLE_PROJECT_ROWS = 4
const PROJECT_MENU_EMPTY_STATE_HEIGHT = 42
const PROJECT_MENU_DIVIDER_BLOCK_HEIGHT = 13
const PROJECT_MENU_ACTION_HEIGHT = 32
const PROJECT_MENU_ACTION_GAP = 2

const CLIPPING_OVERFLOW_RE = /(auto|hidden|scroll|clip)/

function getStackHeight(itemCount: number, itemHeight: number, gap: number) {
  if (itemCount <= 0) return 0
  return itemCount * itemHeight + (itemCount - 1) * gap
}

function extractNetworkHost(value?: string | null): string | null {
  if (!value) return null
  const trimmedValue = value.trim()
  if (!trimmedValue) return null

  const bracketMatch = trimmedValue.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketMatch?.[1]) return bracketMatch[1]

  const colonParts = trimmedValue.split(':')
  if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
    return colonParts[0]
  }

  return trimmedValue
}

function isLoopbackNetworkHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

function getDisplayableNetworkHost(value?: string | null): string | null {
  const host = extractNetworkHost(value)
  if (!host || isLoopbackNetworkHost(host)) return null
  return host
}

export function getDisplayableIp(value?: string | null): string | null {
  const host = getDisplayableNetworkHost(value)
  if (!host) return null
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host
  return null
}

export function getProjectDeviceId(project: ProjectWithTasks): string | undefined {
  return project.config?.execution?.deviceId ?? project.config?.device_id
}

export function isLocalStandaloneDevice(device: DeviceInfo): boolean {
  return device.device_type !== 'cloud' && device.device_type !== 'remote'
}

export function isLocalProjectWorkspaceDevice(device: DeviceInfo | undefined): boolean {
  return Boolean(device && isLocalStandaloneDevice(device))
}

export function getProjectMenuDeviceLabel(
  device: DeviceInfo | undefined,
  workspace: RuntimeDeviceWorkspace | null
): string | null {
  if (isLocalProjectWorkspaceDevice(device)) return null

  return (
    getDisplayableIp(device?.runtime_transfer_host) ??
    getDisplayableIp(device?.client_ip) ??
    getDisplayableIp(workspace?.deviceName) ??
    getDisplayableIp(workspace?.deviceId)
  )
}

export function getProjectMenuFitHeight(projectCount: number, hasCreateProjectOption: boolean) {
  const visibleProjectCount = Math.min(projectCount, PROJECT_MENU_VISIBLE_PROJECT_ROWS)
  const projectListHeight =
    visibleProjectCount > 0
      ? getStackHeight(visibleProjectCount, PROJECT_MENU_ROW_HEIGHT, PROJECT_MENU_ROW_GAP)
      : PROJECT_MENU_EMPTY_STATE_HEIGHT
  const actionCount = hasCreateProjectOption ? 3 : 1
  const actionHeight = getStackHeight(
    actionCount,
    PROJECT_MENU_ACTION_HEIGHT,
    PROJECT_MENU_ACTION_GAP
  )

  return (
    PROJECT_MENU_VERTICAL_PADDING +
    PROJECT_MENU_SEARCH_BLOCK_HEIGHT +
    projectListHeight +
    PROJECT_MENU_DIVIDER_BLOCK_HEIGHT +
    actionHeight
  )
}

export function getMenuVisibleBounds(element: HTMLElement | null) {
  let top = PROJECT_MENU_VIEWPORT_MARGIN
  let bottom = window.innerHeight - PROJECT_MENU_VIEWPORT_MARGIN
  let current = element?.parentElement ?? null

  while (current && current !== document.body) {
    const style = window.getComputedStyle(current)
    const clipsVertically =
      CLIPPING_OVERFLOW_RE.test(style.overflowY) || CLIPPING_OVERFLOW_RE.test(style.overflow)

    if (clipsVertically) {
      const rect = current.getBoundingClientRect()
      if (rect.height > 0) {
        top = Math.max(top, rect.top + PROJECT_MENU_VIEWPORT_MARGIN)
        bottom = Math.min(bottom, rect.bottom - PROJECT_MENU_VIEWPORT_MARGIN)
      }
    }

    current = current.parentElement
  }

  return { top, bottom }
}

export function resolveProjectExecutionUi({
  project,
  executionMode,
  executionModeLocked,
  selectedWorkspaceIsRemote,
  isGitProject,
}: {
  project: ProjectWithTasks | null | undefined
  executionMode: ProjectExecutionMode
  executionModeLocked: boolean
  selectedWorkspaceIsRemote: boolean
  isGitProject?: boolean
}) {
  const supportsWorktree = Boolean(
    project && supportsGitWorktreeExecution(project) && isGitProject !== false
  )
  const displayedMode: ProjectExecutionMode =
    supportsWorktree && executionMode === 'git_worktree' ? 'git_worktree' : 'current_workspace'

  return {
    displayedMode,
    supportsWorktree,
    canShowModeControl: supportsWorktree,
    canOpenModeMenu: supportsWorktree && !selectedWorkspaceIsRemote && !executionModeLocked,
  }
}
