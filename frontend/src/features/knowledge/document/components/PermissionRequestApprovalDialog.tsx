// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission request approval dialog for knowledge bases.
 * Allows managers to view and process pending permission requests.
 */

'use client'

import { Check, Clock, Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  getKbPermissionRequests,
  getPendingPermissionRequests,
  processPermissionRequest,
} from '@/apis/knowledge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import type { PermissionRequestResponse, PermissionType } from '@/types/knowledge'

interface PermissionRequestApprovalDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** If provided, only show requests for this KB. Otherwise show all pending requests. */
  kbId?: number
  kbName?: string
}

export function PermissionRequestApprovalDialog({
  open,
  onOpenChange,
  kbId,
  kbName,
}: PermissionRequestApprovalDialogProps) {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()

  const [requests, setRequests] = useState<PermissionRequestResponse[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [processingId, setProcessingId] = useState<number | null>(null)
  const [responseMessage, setResponseMessage] = useState('')
  const [grantedPermissionType, setGrantedPermissionType] = useState<PermissionType>('read')

  const loadRequests = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = kbId
        ? await getKbPermissionRequests(kbId)
        : await getPendingPermissionRequests()
      setRequests(response.items)
    } catch (error) {
      console.error('Failed to load permission requests:', error)
      toast({
        variant: 'destructive',
        description: t('permission_request.messages.load_failed'),
      })
    } finally {
      setIsLoading(false)
    }
  }, [kbId, t, toast])

  useEffect(() => {
    if (open) {
      loadRequests()
      setResponseMessage('')
    }
  }, [open, loadRequests])

  const handleApprove = async (request: PermissionRequestResponse) => {
    setProcessingId(request.id)
    try {
      await processPermissionRequest(request.id, {
        action: 'approve',
        response_message: responseMessage || undefined,
        granted_permission_type: grantedPermissionType,
      })
      toast({
        description: t('permission_request.messages.approved'),
      })
      await loadRequests()
      setResponseMessage('')
    } catch (error) {
      console.error('Failed to approve request:', error)
      toast({
        variant: 'destructive',
        description: t('permission_request.messages.approve_failed'),
      })
    } finally {
      setProcessingId(null)
    }
  }

  const handleReject = async (request: PermissionRequestResponse) => {
    setProcessingId(request.id)
    try {
      await processPermissionRequest(request.id, {
        action: 'reject',
        response_message: responseMessage || undefined,
      })
      toast({
        description: t('permission_request.messages.rejected'),
      })
      await loadRequests()
      setResponseMessage('')
    } catch (error) {
      console.error('Failed to reject request:', error)
      toast({
        variant: 'destructive',
        description: t('permission_request.messages.reject_failed'),
      })
    } finally {
      setProcessingId(null)
    }
  }

  const permissionTypes: PermissionType[] = ['read', 'download', 'write', 'manage']

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {kbId
              ? t('permission_request.approval.title_kb', { name: kbName })
              : t('permission_request.approval.title')}
          </DialogTitle>
          <DialogDescription>{t('permission_request.approval.description')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : requests.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            {t('permission_request.approval.no_requests')}
          </div>
        ) : (
          <div className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('permission_request.approval.columns.applicant')}</TableHead>
                  {!kbId && (
                    <TableHead>{t('permission_request.approval.columns.kb_name')}</TableHead>
                  )}
                  <TableHead>{t('permission_request.approval.columns.requested')}</TableHead>
                  <TableHead>{t('permission_request.approval.columns.reason')}</TableHead>
                  <TableHead>{t('permission_request.approval.columns.time')}</TableHead>
                  <TableHead className="w-[200px]">
                    {t('permission_request.approval.columns.actions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map(request => (
                  <TableRow key={request.id}>
                    <TableCell className="font-medium">{request.applicant_username}</TableCell>
                    {!kbId && (
                      <TableCell>
                        <span className="text-sm">{request.kb_name || '-'}</span>
                      </TableCell>
                    )}
                    <TableCell>
                      <Badge variant="secondary">
                        {t(`permission.type.${request.requested_permission_type}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="line-clamp-2 text-sm text-muted-foreground">
                        {request.request_reason || '-'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {formatDate(request.created_at)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-green-600 hover:bg-green-50 hover:text-green-700"
                          onClick={() => handleApprove(request)}
                          disabled={processingId === request.id}
                        >
                          {processingId === request.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-600 hover:bg-red-50 hover:text-red-700"
                          onClick={() => handleReject(request)}
                          disabled={processingId === request.id}
                        >
                          {processingId === request.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <X className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Response options */}
            <div className="space-y-4 rounded-lg border p-4">
              <div className="space-y-2">
                <Label>{t('permission_request.approval.grant_permission')}</Label>
                <Select
                  value={grantedPermissionType}
                  onValueChange={(value: PermissionType) => setGrantedPermissionType(value)}
                >
                  <SelectTrigger className="w-[200px]">
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
                  {t('permission_request.approval.grant_permission_hint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label>{t('permission_request.approval.response_message')}</Label>
                <Input
                  value={responseMessage}
                  onChange={e => setResponseMessage(e.target.value)}
                  placeholder={t('permission_request.approval.response_placeholder')}
                  maxLength={500}
                />
                <p className="text-xs text-muted-foreground">
                  {t('permission_request.approval.response_hint')}
                </p>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
