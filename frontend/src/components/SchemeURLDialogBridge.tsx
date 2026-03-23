// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useToast } from '@/hooks/use-toast'
import { paths } from '@/config/paths'
import { taskApis } from '@/apis/tasks'
import { getRegisteredModal } from '@/lib/scheme/modal-registry'
import { McpProviderConfigDialog } from '@/features/settings/components/McpProviderConfigDialog'

type OpenDialogDetail = {
  type?: string
  params?: Record<string, unknown>
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
  const [isMcpProviderConfigOpen, setIsMcpProviderConfigOpen] = useState(false)
  const [mcpProviderId, setMcpProviderId] = useState<string>('dingtalk')
  const [mcpProviderServiceId, setMcpProviderServiceId] = useState<string>('docs')
  const [activeModal, setActiveModal] = useState<OpenDialogDetail | null>(null)

  const getCurrentTaskId = useCallback((): number | null => {
    if (typeof window === 'undefined') return null

    const pathname = window.location.pathname
    const match = pathname.match(/^\/(chat|code)$/)
    if (!match) return null

    const searchParams = new URLSearchParams(window.location.search)
    const taskIdStr = searchParams.get('taskId')
    if (!taskIdStr) return null

    const taskId = Number(taskIdStr)
    return isNaN(taskId) ? null : taskId
  }, [])

  const handleOpenDialog = useCallback(
    (e: Event) => {
      const detail = (e as CustomEvent).detail as OpenDialogDetail | undefined
      const dialogType = detail?.type
      const params = detail?.params || {}

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
        if (params.team) {
          router.push(`${paths.code.getHref()}?team=${params.team}`)
        } else {
          router.push(paths.code.getHref())
        }
        return
      }

      if (dialogType === 'create-subscription') {
        const currentPath = window.location.pathname

        if (currentPath === paths.feed.getHref()) {
          setTimeout(() => {
            const event = new CustomEvent('wegent:open-dialog', {
              detail: { type: 'create-subscription', params },
            })
            window.dispatchEvent(event)
          }, 100)
        } else {
          router.push(paths.feed.getHref())
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

      if (dialogType === 'mcp-provider-config') {
        const providerParam = params.provider
        const serviceParam = params.service
        const providerId = Array.isArray(providerParam) ? providerParam[0] : providerParam
        const serviceId = Array.isArray(serviceParam) ? serviceParam[0] : serviceParam
        setMcpProviderId(typeof providerId === 'string' && providerId ? providerId : 'dingtalk')
        setMcpProviderServiceId(typeof serviceId === 'string' && serviceId ? serviceId : 'docs')
        setIsMcpProviderConfigOpen(true)
        return
      }

      if (dialogType && getRegisteredModal(dialogType)) {
        setActiveModal({
          type: dialogType,
          params,
        })
        return
      }

      if (dialogType === 'share') {
        const shareType = params.shareType as string
        let shareId = params.shareId as string
        const effectiveType = shareType || 'task'

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

        if (!shareId) {
          toast({
            variant: 'destructive',
            title: 'Invalid share parameters',
            description: 'id parameter is required',
          })
          return
        }

        toast({
          title: `Share ${effectiveType} not yet implemented`,
          description: `Sharing ${effectiveType} with ID ${shareId} is not yet supported`,
        })
        return
      }

      toast({ title: `Scheme dialog not implemented: ${dialogType || 'unknown'}` })
    },
    [getCurrentTaskId, router, toast]
  )

  const handleExportEvent = useCallback(
    async (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { type: string; taskId?: string; fileId?: string }
        | undefined

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
        const response = await taskApis.shareTask(taskId)
        await navigator.clipboard.writeText(response.share_url)

        toast({
          title: 'Share link copied!',
          description: 'You can share this link to export or view the task.',
        })
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

  const registeredModal = activeModal?.type ? getRegisteredModal(activeModal.type) : undefined
  const RegisteredModalComponent = registeredModal?.component

  return (
    <>
      <McpProviderConfigDialog
        open={isMcpProviderConfigOpen}
        onOpenChange={setIsMcpProviderConfigOpen}
        providerId={mcpProviderId}
        serviceId={mcpProviderServiceId}
      />
      {RegisteredModalComponent ? (
        <RegisteredModalComponent
          open={true}
          onOpenChange={open => {
            if (!open) {
              setActiveModal(null)
            }
          }}
          params={activeModal?.params}
        />
      ) : null}
    </>
  )
}
