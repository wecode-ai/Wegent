import { isQuestionDiscussionTab } from '@/features/notifications/questionDiscussion'
import { getMcpAppPanel, isMcpAppPanelTab } from '@/features/mcp-apps/workspacePanels'
import {
  Bot,
  File,
  FileDiff,
  Globe2,
  LayoutDashboard,
  ListChecks,
  MessageCircle,
  PanelRight,
  SquareTerminal,
} from 'lucide-react'

import { unwrapShellCommand } from '@/components/chat/blocks/toolBlockActivity'

import type { LocalHarnessWorkbenchSession } from '@/components/layout/localHarnessWorkbench'

import { useTranslation } from '@/hooks/useTranslation'

import { getPlatform } from '@/lib/platform'

import { isWorkspaceFileTab, type WorkspaceFileTabId } from './workspaceFileTabs'

import type { BackgroundTerminal } from '../backgroundTerminals'

import {
  resolveRightWorkspaceExtensionDescriptor,
  isRightWorkspaceExtensionTab,
  titleOfWeworkWorkspaceSidebarTab,
  type RightWorkspaceExtensionTab,
  type RightWorkspaceExtensionTabState,
} from './rightWorkspaceDshSidebar'
import type {
  RightWorkspaceChatTab,
  RightWorkspaceBrowserTab,
  RightWorkspaceHarnessTab,
  RightWorkspaceTerminalTab,
  RightWorkspacePanelTab,
  RightWorkspacePanelView,
  RightWorkspaceBrowserState,
} from './RightWorkspacePanel.types'

export function getRightWorkspaceShortcuts(platform: ReturnType<typeof getPlatform>) {
  if (platform !== 'mac') {
    return {
      review: 'Alt+Ctrl+R',
      browser: 'Ctrl+T',
      chat: 'Alt+Ctrl+S',
      files: 'Alt+Ctrl+F',
    } as const
  }
  return {
    review: '⌥⌘R',
    browser: '⌘T',
    chat: '⌥⌘S',
    files: '⌥⌘F',
  } as const
}

export function isRightWorkspaceChatTab(
  tab: RightWorkspacePanelView
): tab is RightWorkspaceChatTab {
  return tab.startsWith('chat:')
}

export function isRightWorkspaceBrowserTab(
  tab: RightWorkspacePanelView
): tab is RightWorkspaceBrowserTab {
  return tab.startsWith('browser:')
}

export function isRightWorkspaceHarnessTab(
  tab: RightWorkspacePanelView
): tab is RightWorkspaceHarnessTab {
  return tab.startsWith('harness:')
}

export function isRightWorkspaceTerminalTab(
  tab: RightWorkspacePanelView
): tab is RightWorkspaceTerminalTab {
  return tab.startsWith('terminal:')
}

export function getRightWorkspaceHarnessSessionId(tab: RightWorkspaceHarnessTab) {
  return tab.slice('harness:'.length)
}

export function getRightWorkspaceChatTabSuffix(tab: RightWorkspaceChatTab) {
  return tab.slice('chat:'.length)
}

export function requestIdForWorkspaceFileTab(tab: WorkspaceFileTabId): number {
  let hash = 0
  for (const character of tab) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0
  }
  return hash >>> 0
}

export function getRightWorkspaceBrowserTabSuffix(tab: RightWorkspaceBrowserTab) {
  return tab.slice('browser:'.length)
}

export function getRightWorkspaceTerminalTabSuffix(tab: RightWorkspaceTerminalTab) {
  return tab.slice('terminal:'.length)
}

export function getRightWorkspaceTabLabel(
  tab: RightWorkspacePanelTab,
  t: ReturnType<typeof useTranslation>['t'],
  browserStates: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>,
  harnessSessionsById: Map<string, LocalHarnessWorkbenchSession>,
  extensionTabs: Partial<Record<RightWorkspaceExtensionTab, RightWorkspaceExtensionTabState>>,
  backgroundTerminals: BackgroundTerminal[]
) {
  if (isMcpAppPanelTab(tab)) return getMcpAppPanel(tab)?.title ?? t('mcp_apps.title')
  if (isQuestionDiscussionTab(tab)) return t('question_discussion.title')
  if (tab.startsWith('background-terminal:')) {
    return (
      unwrapShellCommand(
        backgroundTerminals.find(terminal => terminal.tabId === tab)?.command ?? ''
      ) || t('workbench.background_terminal')
    )
  }
  if (isRightWorkspaceExtensionTab(tab)) {
    const descriptor = resolveRightWorkspaceExtensionDescriptor(extensionTabs[tab])
    if (!descriptor) return t('workbench.workspace_tab_plugin', '插件')
    return titleOfWeworkWorkspaceSidebarTab(descriptor, t)
  }
  if (tab === 'review') return t('workbench.workspace_tab_review', '审查')
  if (isRightWorkspaceTerminalTab(tab)) {
    const suffix = getRightWorkspaceTerminalTabSuffix(tab)
    return suffix === '1'
      ? t('workbench.terminal', '终端')
      : `${t('workbench.terminal', '终端')} ${suffix}`
  }
  if (isRightWorkspaceBrowserTab(tab)) {
    const browserState = browserStates[tab]
    return (
      browserState?.developmentPreview?.displayName ||
      browserState?.title ||
      t('workbench.browser_new_tab', '新选项卡')
    )
  }
  if (isRightWorkspaceChatTab(tab)) return t('workbench.workspace_tab_chat', '临时聊天')
  if (isRightWorkspaceHarnessTab(tab)) {
    return (
      harnessSessionsById.get(getRightWorkspaceHarnessSessionId(tab))?.title ??
      t('workbench.harness_session_picker_title', '新建编码会话')
    )
  }
  if (tab === 'plan') return t('workbench.workspace_tab_plan', '计划')
  if (tab === 'subagents') return t('workbench.workspace_tab_subagents', '子代理')
  if (tab === 'work-item') return t('workbench.work_item_detail', 'Issue 详情')
  return t('workbench.workspace_tab_files', '文件')
}

export function getRightWorkspaceTabTestId(tab: RightWorkspacePanelTab) {
  if (isMcpAppPanelTab(tab)) return `right-workspace-mcp-app-tab-${tab.slice(8)}`
  if (isQuestionDiscussionTab(tab)) return `right-workspace-discussion-tab-${tab.slice(11)}`
  if (isWorkspaceFileTab(tab)) return `right-workspace-file-tab-${tab.slice('file:'.length)}`
  if (isRightWorkspaceExtensionTab(tab)) {
    return `right-workspace-extension-tab-${tab.slice('dsh:'.length)}`
  }
  if (isRightWorkspaceTerminalTab(tab)) {
    const suffix = getRightWorkspaceTerminalTabSuffix(tab)
    return suffix === '1'
      ? 'right-workspace-terminal-tab'
      : `right-workspace-terminal-tab-${suffix}`
  }
  if (tab === 'files') return 'right-workspace-file-tab'
  if (isRightWorkspaceChatTab(tab)) {
    return `right-workspace-chat-tab-${getRightWorkspaceChatTabSuffix(tab)}`
  }
  if (isRightWorkspaceBrowserTab(tab)) {
    return `right-workspace-browser-tab-${getRightWorkspaceBrowserTabSuffix(tab)}`
  }
  if (isRightWorkspaceHarnessTab(tab)) {
    return `right-workspace-harness-tab-${getRightWorkspaceHarnessSessionId(tab)}`
  }
  return `right-workspace-${tab}-tab`
}

export function getRightWorkspaceTabIcon(tab: RightWorkspacePanelTab) {
  if (isMcpAppPanelTab(tab)) return PanelRight
  if (isQuestionDiscussionTab(tab)) return MessageCircle
  if (tab.startsWith('background-terminal:')) return SquareTerminal
  if (isRightWorkspaceExtensionTab(tab)) return PanelRight
  if (tab === 'review') return FileDiff
  if (isRightWorkspaceTerminalTab(tab)) return SquareTerminal
  if (isRightWorkspaceBrowserTab(tab)) return Globe2
  if (isRightWorkspaceChatTab(tab)) return MessageCircle
  if (isRightWorkspaceHarnessTab(tab)) return SquareTerminal
  if (tab === 'plan') return ListChecks
  if (tab === 'subagents') return Bot
  if (tab === 'work-item') return LayoutDashboard
  return File
}
