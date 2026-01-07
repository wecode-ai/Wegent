// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import Modal from '@/features/common/Modal'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { DocumentDuplicateIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { useTraceAction } from '@/hooks/useTraceAction'

interface TaskShareModalProps {
  visible: boolean
  onClose: () => void
  taskTitle: string
  shareUrl: string
}

export default function TaskShareModal({
  visible,
  onClose,
  taskTitle,
  shareUrl,
}: TaskShareModalProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { traced } = useTraceAction()

  // Create a traced version of the copy function
  const handleCopyLink = traced('copy-share-link', {
    'action.type': 'copy',
    'copy.content_type': 'share_link',
    'task.title': taskTitle,
  })(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast({
        title: t('shared-task:link_copied'),
        description: t('shared-task:link_copied_desc'),
      })
      onClose()
    } catch {
      // Fallback to traditional method if clipboard API is not available
      const textArea = document.createElement('textarea')
      textArea.value = shareUrl
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      toast({
        title: t('shared-task:link_copied'),
        description: t('shared-task:link_copied_desc'),
      })
      onClose()
    }
  })

  return (
    <Modal
      isOpen={visible}
      onClose={onClose}
      title={t('shared-task:share_success_title')}
      maxWidth="lg"
    >
      <div>
        <div className="space-y-6">
          {/* Success message */}
          <div className="text-center">
            <p className="text-lg font-medium text-text-primary leading-relaxed">
              {t('shared-task:share_success_message_prefix')}
              <span className="text-lg font-semibold text-blue-600"> {taskTitle} </span>
              {t('shared-task:share_success_message_suffix')}
            </p>
          </div>

          {/* Instructions */}
          <div className="mx-auto max-w-md">
            <Alert variant="default" className="text-sm">
              <AlertDescription>{t('shared-task:share_link_info')}</AlertDescription>
            </Alert>
            <div className="mt-2"></div>
            <Alert variant="default" className="text-sm mt-2">
              <AlertDescription>{t('shared-task:share_continue_info')}</AlertDescription>
            </Alert>
          </div>
        </div>

        {/* Bottom button area */}
        <div className="flex space-x-3 mt-6">
          <Button onClick={onClose} variant="outline" size="sm" style={{ flex: 1 }}>
            {t('common:common.cancel')}
          </Button>
          <Button onClick={handleCopyLink} variant="default" size="sm" style={{ flex: 1 }}>
            <DocumentDuplicateIcon className="w-4 h-4" />
            {t('shared-task:copy_link')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
