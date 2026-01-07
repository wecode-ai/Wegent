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

interface TeamShareModalProps {
  visible: boolean
  onClose: () => void
  teamName: string
  shareUrl: string
}

export default function TeamShareModal({
  visible,
  onClose,
  teamName,
  shareUrl,
}: TeamShareModalProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast({
        title: t('common:teams.copy_success'),
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
        title: t('common:teams.copy_success'),
      })
      onClose()
    }
  }

  return (
    <Modal
      isOpen={visible}
      onClose={onClose}
      title={t('common:teams.share_success_title')}
      maxWidth="lg"
    >
      <div>
        <div className="space-y-6">
          {/* Success message */}
          <div className="text-center">
            <p className="text-lg font-medium text-text-primary leading-relaxed">
              {t('common:teams.share_success_message_prefix')}
              <span className="text-lg font-semibold text-blue-600"> {teamName} </span>
              {t('common:teams.share_success_message_suffix')}
            </p>
          </div>

          {/* Instructions */}
          <div className="mx-auto max-w-md">
            <Alert variant="default" className="text-sm">
              <AlertDescription>{t('common:teams.share_instructions_content1')}</AlertDescription>
            </Alert>
            <div className="mt-2"></div>
            <Alert variant="default" className="text-sm mt-2">
              <AlertDescription>{t('common:teams.share_instructions_content2')}</AlertDescription>
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
            {t('common:teams.copy_link')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
