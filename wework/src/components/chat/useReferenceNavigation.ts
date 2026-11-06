import { useCallback, useContext, useMemo } from 'react'
import { WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { parseConversationMentionHref } from '@/lib/conversation-mentions'
import { parseIssueMentionHref } from '@/lib/issue-mentions'
import { openIssueReference } from '@/features/todo/openIssueReference'

export interface ReferenceNavigation {
  openConversation: (href: string) => void
  openIssue: (href: string, label: string) => void
  openReference: (href: string, label: string) => void
}

/**
 * Opens composer and user-message references through the active workbench pane.
 * Conversation references stay in the current pane; Issue references reuse or
 * open the matching project-space board tab.
 */
export function useReferenceNavigation(): ReferenceNavigation {
  const openRuntimeTask = useContext(WorkbenchPaneContext)?.openRuntimeTask
  const workspaceTabs = useOptionalWorkspaceTabs()

  /** Opens a conversation reference in the current pane or route. */
  const openConversation = useCallback(
    (href: string) => {
      const address = parseConversationMentionHref(href)
      if (!address) return
      if (openRuntimeTask) {
        void openRuntimeTask(address)
        return
      }
      navigateTo(buildRuntimeTaskRoute(address))
    },
    [openRuntimeTask]
  )

  /** Opens an Issue reference in the matching board tab. */
  const openIssue = useCallback(
    (href: string, label: string) => {
      const issue = parseIssueMentionHref(href)
      if (!issue) return
      const activeRoute =
        workspaceTabs?.activeTab.contentRoute ??
        `${window.location.pathname}${window.location.search}`
      openIssueReference({
        issue,
        label,
        activeRoute,
        workspaceTabs,
        navigate: navigateTo,
      })
    },
    [workspaceTabs]
  )

  /** Dispatches a composer reference to the conversation or Issue handler. */
  const openReference = useCallback(
    (href: string, label: string) => {
      if (parseConversationMentionHref(href)) {
        openConversation(href)
        return
      }
      if (parseIssueMentionHref(href)) {
        openIssue(href, label)
      }
    },
    [openConversation, openIssue]
  )

  return useMemo(
    () => ({ openConversation, openIssue, openReference }),
    [openConversation, openIssue, openReference]
  )
}
