import {
  AppWindow,
  Archive,
  Code2,
  Cpu,
  FolderGit2,
  GitPullRequest,
  Globe2,
  Info,
  Keyboard,
  MessageSquareText,
  MonitorCog,
  Network,
  Package,
  Palette,
  ScanLine,
  Server,
  Settings,
  SlidersHorizontal,
  Terminal,
  UserRound,
  Webhook,
} from 'lucide-react'

import type { WeworkSettingsIcon } from './dshSettings'

const icons: Record<string, WeworkSettingsIcon> = {
  'app-window': AppWindow,
  archive: Archive,
  'code-2': Code2,
  cpu: Cpu,
  'folder-git-2': FolderGit2,
  'git-pull-request': GitPullRequest,
  'globe-2': Globe2,
  info: Info,
  keyboard: Keyboard,
  'message-square-text': MessageSquareText,
  'monitor-cog': MonitorCog,
  network: Network,
  package: Package,
  palette: Palette,
  'scan-line': ScanLine,
  server: Server,
  'sliders-horizontal': SlidersHorizontal,
  terminal: Terminal,
  'user-round': UserRound,
  webhook: Webhook,
}

export function resolveDshSettingsIcon(id: string | undefined): WeworkSettingsIcon {
  return (id && icons[id]) || Settings
}
