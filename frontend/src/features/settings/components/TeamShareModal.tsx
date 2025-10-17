// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import Modal from '@/features/common/Modal'
import { Button, App, Alert } from 'antd'
import { DocumentDuplicateIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'

interface TeamShareModalProps {
  visible: boolean
  onClose: () => void
  teamName: string
  shareUrl: string
}

export default function TeamShareModal({ visible, onClose, teamName, shareUrl }: TeamShareModalProps) {
  const { t } = useTranslation('common')
  const { message } = App.useApp()

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      message.success(t('teams.copy_success'))
    } catch (error) {
      // Fallback to traditional method if clipboard API is not available
      const textArea = document.createElement('textarea')
      textArea.value = shareUrl
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      message.success(t('teams.copy_success'))
    }
  }

  return (
    <Modal
      isOpen={visible}
      onClose={onClose}
      title={t('teams.share_success_title')}
      maxWidth="lg"
    >
      <div>
        <div className="space-y-6">
          {/* Success message */}
          <div className="text-center">
            <p className="text-lg font-medium text-text-primary leading-relaxed">
              {t('teams.share_success_message_prefix')}
              <span className="text-lg font-semibold text-blue-600">{" "}{teamName}{" "}</span>
              {t('teams.share_success_message_suffix')}
            </p>
          </div>

          {/* Instructions */}
          <div className="mx-auto max-w-md">
            <Alert
              description={t('teams.share_instructions_content1')}
              type="info"
              showIcon
              className="text-sm"
            />
            <div className='mt-2'></div>
            <Alert
              description={t('teams.share_instructions_content2')}
              type="info"
              showIcon
              className="text-sm mt-2"
            />
          </div>
        </div>

        {/* Bottom button area */}
        <div className="flex space-x-3 mt-6">
          <Button
            onClick={onClose}
            type="default"
            size="small"
            style={{ flex: 1 }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleCopyLink}
            type="primary"
            size="small"
            icon={<DocumentDuplicateIcon className="w-4 h-4" />}
            style={{ flex: 1 }}
          >
            {t('teams.copy_link')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}