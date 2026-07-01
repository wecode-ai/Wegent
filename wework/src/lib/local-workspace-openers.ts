export const LOCAL_WORKSPACE_OPENERS = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'vscode-insiders', label: 'VS Code Insiders' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'sublime-text', label: 'Sublime Text' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'finder', label: 'Finder' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'iterm2', label: 'iTerm2' },
  { id: 'ghostty', label: 'Ghostty' },
  { id: 'warp', label: 'Warp' },
  { id: 'xcode', label: 'Xcode' },
  { id: 'android-studio', label: 'Android Studio' },
  { id: 'intellij-idea', label: 'IntelliJ IDEA' },
] as const

export type LocalWorkspaceOpenerId = (typeof LOCAL_WORKSPACE_OPENERS)[number]['id']

export const DEFAULT_LOCAL_WORKSPACE_OPENER_ID: LocalWorkspaceOpenerId = 'vscode'
