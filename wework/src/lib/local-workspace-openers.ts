import type { DesktopPlatform } from './platform'

export type OpenerCategory = 'general' | 'fileManager' | 'terminal' | 'macOnly' | 'winOnly'

export interface LocalWorkspaceOpenerDef {
  id: string
  label: string
  category: OpenerCategory
}

export const LOCAL_WORKSPACE_OPENERS = [
  { id: 'vscode', label: 'VS Code', category: 'general' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', category: 'general' },
  { id: 'cursor', label: 'Cursor', category: 'general' },
  { id: 'sublime-text', label: 'Sublime Text', category: 'general' },
  { id: 'windsurf', label: 'Windsurf', category: 'general' },
  { id: 'intellij-idea', label: 'IntelliJ IDEA', category: 'general' },
  { id: 'android-studio', label: 'Android Studio', category: 'general' },
  { id: 'file-manager', label: 'File Manager', category: 'fileManager' },
  { id: 'terminal', label: 'Terminal', category: 'terminal' },
  { id: 'xcode', label: 'Xcode', category: 'macOnly' },
  { id: 'iterm2', label: 'iTerm2', category: 'macOnly' },
  { id: 'ghostty', label: 'Ghostty', category: 'macOnly' },
  { id: 'warp', label: 'Warp', category: 'macOnly' },
  { id: 'cmd', label: 'CMD', category: 'winOnly' },
  { id: 'powershell', label: 'PowerShell', category: 'winOnly' },
  { id: 'custom', label: 'Custom', category: 'general' },
] as const

export type LocalWorkspaceOpenerId = (typeof LOCAL_WORKSPACE_OPENERS)[number]['id']

export const DEFAULT_LOCAL_WORKSPACE_OPENER_ID: LocalWorkspaceOpenerId = 'vscode'

export function visibleOpenersForPlatform(platform: DesktopPlatform): LocalWorkspaceOpenerDef[] {
  return LOCAL_WORKSPACE_OPENERS.filter(opener => {
    if (opener.category === 'macOnly') return platform === 'mac'
    if (opener.category === 'winOnly') return platform === 'win'
    return true
  })
}
