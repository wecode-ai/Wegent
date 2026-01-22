// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'

import { useToast } from '@/hooks/use-toast'
import { paths } from '@/config/paths'
import { taskApis } from '@/apis/tasks'

type OpenDialogDetail = {
  type?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any>
}

/**
 * Global bridge for `wegent:open-dialog` and `wegent:export` events.
 *
 * The scheme system dispatches `wegent:open-dialog` for wegent://form/* and wegent://modal/*.
 * The scheme system dispatches `wegent:export` for wegent://action/export-* URLs.
 * This component lives at the app root so that scheme URLs work from anywhere.
 */
export default function SchemeURLDialogBridge() {
  const router = useRouter()
  const { toast } = useToast()

  const handleOpenDialog = useCallback(
    (e: Event) => {
      const detail = (e as CustomEvent).detail as OpenDialogDetail | undefined
      const dialogType = detail?.type
      const params = detail?.params || {}

      console.log('[SchemeURLDialogBridge] Opening dialog:', dialogType, params)

      // Forms - redirect to appropriate pages
      if (dialogType === 'create-team') {
        router.push(paths.settings.team.getHref())
        return
      }

      if (dialogType === 'create-bot') {
        router.push(paths.settings.bot.getHref())
        return
      }

      if (dialogType === 'add-repository') {
        router.push(paths.wiki.getHref())
        return
      }

      if (dialogType === 'create-task') {
        // Redirect to code page if team is specified
        if (params.team) {
          router.push(`${paths.code.getHref()}?team=${params.team}`)
        } else {
          router.push(paths.code.getHref())
        }
        return
      }

      if (dialogType === 'create-subscription') {
        // Redirect to feed page where SubscriptionPage will handle opening the dialog
        const currentPath = window.location.pathname

        if (currentPath === paths.feed.getHref()) {
          // Already on feed page, re-dispatch the event after a short delay
          // to ensure SubscriptionPage listener is ready
          setTimeout(() => {
            const event = new CustomEvent('wegent:open-dialog', {
              detail: { type: 'create-subscription', params },
            })
            window.dispatchEvent(event)
          }, 100)
        } else {
          // Navigate to feed page first, then the event will be handled by SubscriptionPage
          router.push(paths.feed.getHref())
          // The event will need to be re-dispatched after navigation
          // Store it in sessionStorage to trigger after page load
          sessionStorage.setItem(
            'wegent:pending-dialog',
            JSON.stringify({
              type: 'create-subscription',
              params,
            })
          )
        }
        return
      }

      // Actions requiring dialogs
      if (dialogType === 'share') {
        const shareType = params.shareType as string
        let shareId = params.shareId as string

        // If no type specified, default to 'task'
        const effectiveType = shareType || 'task'

        // For task sharing, allow getting ID from current URL if not provided
        if (effectiveType === 'task') {
          if (!shareId) {
            const currentTaskId = getCurrentTaskId()
            if (currentTaskId) {
              shareId = String(currentTaskId)
            }
          }

          if (!shareId) {
            toast({
              variant: 'destructive',
              title: 'No task to share',
              description: 'Please open a task first or provide an id parameter',
            })
            return
          }

          const taskId = Number(shareId)
          if (isNaN(taskId)) {
            toast({
              variant: 'destructive',
              title: 'Invalid task ID',
            })
            return
          }

          taskApis
            .shareTask(taskId)
            .then(response => {
              navigator.clipboard.writeText(response.share_url)
              toast({
                title: 'Share link copied!',
                description: 'You can share this link to view the task.',
              })
            })
            .catch(error => {
              console.error('Failed to generate share link:', error)
              toast({
                variant: 'destructive',
                title: 'Failed to generate share link',
                description: error instanceof Error ? error.message : 'Unknown error',
              })
            })
          return
        }

        // For other types, ID is required
        if (!shareId) {
          toast({
            variant: 'destructive',
            title: 'Invalid share parameters',
            description: 'id parameter is required',
          })
          return
        }

        // For other types, show a message
        toast({
          title: `Share ${effectiveType} not yet implemented`,
          description: `Sharing ${effectiveType} with ID ${shareId} is not yet supported`,
        })
        return
      }

      toast({ title: `Scheme dialog not implemented: ${dialogType || 'unknown'}` })
    },
    [router, toast]
  )

  /**
   * Get current task ID from URL path
   * Supports both /chat and /code pages
   */
  const getCurrentTaskId = useCallback((): number | null => {
    if (typeof window === 'undefined') return null

    const pathname = window.location.pathname
    // Match /chat or /code routes
    const match = pathname.match(/^\/(chat|code)$/)
    if (!match) return null

    // Get taskId from URL search params
    const searchParams = new URLSearchParams(window.location.search)
    const taskIdStr = searchParams.get('taskId')
    if (!taskIdStr) return null

    const taskId = Number(taskIdStr)
    return isNaN(taskId) ? null : taskId
  }, [])

  const handleExportEvent = useCallback(
    async (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { type: string; taskId?: string; fileId?: string }
        | undefined

      // Get taskId from event detail or current URL
      let taskId: number | null = null
      if (detail?.taskId) {
        taskId = Number(detail.taskId)
        if (isNaN(taskId)) {
          toast({
            variant: 'destructive',
            title: 'Invalid task ID',
          })
          return
        }
      } else {
        // Try to get from current URL
        taskId = getCurrentTaskId()
        if (!taskId) {
          toast({
            variant: 'destructive',
            title: 'No task selected',
            description: 'Please open a task first or provide a taskId parameter',
          })
          return
        }
      }

      try {
        // Generate share link for the task
        const response = await taskApis.shareTask(taskId)

        // Copy share link to clipboard
        await navigator.clipboard.writeText(response.share_url)

        toast({
          title: 'Share link copied!',
          description: 'You can share this link to export or view the task.',
        })

        // Optionally open the share link in a new tab for immediate access
        // window.open(response.share_url, '_blank')
      } catch (error) {
        console.error('Failed to generate share link:', error)
        toast({
          variant: 'destructive',
          title: 'Failed to generate share link',
          description: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    },
    [getCurrentTaskId, toast]
  )

  useEffect(() => {
    window.addEventListener('wegent:open-dialog', handleOpenDialog)
    window.addEventListener('wegent:export', handleExportEvent)
    return () => {
      window.removeEventListener('wegent:open-dialog', handleOpenDialog)
      window.removeEventListener('wegent:export', handleExportEvent)
    }
  }, [handleOpenDialog, handleExportEvent])

  return null
}
