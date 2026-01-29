// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission request dialog for knowledge bases.
 * Allows users to request access to a knowledge base they don't have permission for.
 */

'use client'

import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { createPermissionRequest } from '@/apis/knowledge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import type { KnowledgeShareInfoResponse } from '@/types/knowledge'

interface PermissionRequestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbInfo: KnowledgeShareInfoResponse
  onSuccess?: () => void
}

type RequestPermissionType = 'read' | 'download' | 'write'

export function PermissionRequestDialog({
  open,
  onOpenChange,
  kbInfo,
  onSuccess,
}: PermissionRequestDialogProps) {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()

  const [requestReason, setRequestReason] = useState('')
  const [requestedPermissionType, setRequestedPermissionType] =
    useState<RequestPermissionType>('read')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async () => {
    setIsSubmitting(true)
    try {
      await createPermissionRequest({
        kind_id: kbInfo.kb_id,
        request_reason: requestReason || undefined,
        requested_permission_type: requestedPermissionType,
      })

      toast({
        description: t('permission_request.messages.submitted'),
      })

      onOpenChange(false)
      onSuccess?.()
    } catch (error: unknown) {
      console.error('Failed to submit permission request:', error)
      const errorMessage =
        error instanceof Error ? error.message : t('permission_request.messages.submit_failed')
      toast({
        variant: 'destructive',
        description: errorMessage,
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const permissionTypes: RequestPermissionType[] = ['read', 'download', 'write']

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('permission_request.title')}</DialogTitle>
          <DialogDescription>{t('permission_request.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Knowledge base info */}
          <div className="rounded-lg border bg-muted/50 p-4">
            <div className="space-y-2">
              <div>
                <span className="text-sm text-muted-foreground">
                  {t('permission_request.kb_name')}:
                </span>
                <span className="ml-2 font-medium">{kbInfo.name}</span>
              </div>
              <div>
                <span className="text-sm text-muted-foreground">
                  {t('permission_request.kb_owner')}:
                </span>
                <span className="ml-2">{kbInfo.owner_username}</span>
              </div>
              {kbInfo.description && (
                <div>
                  <span className="text-sm text-muted-foreground">
                    {t('permission_request.kb_description')}:
                  </span>
                  <p className="mt-1 text-sm">{kbInfo.description}</p>
                </div>
              )}
            </div>
          </div>

          {/* Permission type selection */}
          <div className="space-y-2">
            <Label htmlFor="permission-type">{t('permission_request.requested_permission')}</Label>
            <Select
              value={requestedPermissionType}
              onValueChange={(value: RequestPermissionType) => setRequestedPermissionType(value)}
            >
              <SelectTrigger id="permission-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {permissionTypes.map(type => (
                  <SelectItem key={type} value={type}>
                    {t(`permission.type.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(`permission_request.permission_hint.${requestedPermissionType}`)}
            </p>
          </div>

          {/* Request reason */}
          <div className="space-y-2">
            <Label htmlFor="request-reason">{t('permission_request.reason_label')}</Label>
            <Textarea
              id="request-reason"
              value={requestReason}
              onChange={e => setRequestReason(e.target.value)}
              placeholder={t('permission_request.reason_placeholder')}
              rows={3}
              maxLength={1000}
            />
            <p className="text-xs text-muted-foreground">{t('permission_request.reason_hint')}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('permission_request.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
