// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ExternalLink, Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'

type DingTalkDownloadDialogProps = {
  open: boolean
  filename: string
  /** Whether the robot-send action is currently in progress */
  isSending: boolean
  onOpenChange: (open: boolean) => void
  /** Open the file download URL in the native browser */
  onOpenInBrowser: () => void
  /** Send the file via DingTalk robot */
  onSendViaRobot: () => void
}

export function DingTalkDownloadDialog({
  open,
  filename,
  isSending,
  onOpenChange,
  onOpenInBrowser,
  onSendViaRobot,
}: DingTalkDownloadDialogProps) {
  const { t } = useTranslation('tasks')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[90vw] max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('remote_workspace.dingtalk_download.title', '下载文件')}</DialogTitle>
          <DialogDescription>
            <span className="block mb-1 font-medium text-text-primary">{filename}</span>
            {t(
              'remote_workspace.dingtalk_download.description',
              '钉钉内置浏览器限制，无法直接下载文件。请选择以下方式获取文件：'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 pt-2">
          {/* Option 1: Open in native browser */}
          <button
            type="button"
            onClick={onOpenInBrowser}
            className="flex items-start gap-3 rounded-lg border border-border p-4 text-left hover:bg-surface transition-colors"
          >
            <ExternalLink className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <div className="text-sm font-medium text-text-primary">
                {t('remote_workspace.dingtalk_download.open_in_browser', '生成下载链接')}
              </div>
            </div>
          </button>

          {/* Option 2: Send via DingTalk robot */}
          <button
            type="button"
            onClick={onSendViaRobot}
            disabled={isSending}
            className="flex items-start gap-3 rounded-lg border border-border p-4 text-left hover:bg-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <div className="text-sm font-medium text-text-primary">
                {isSending
                  ? t('remote_workspace.dingtalk_download.sending', '正在发送...')
                  : t('remote_workspace.dingtalk_download.send_via_robot', '使用钉钉机器人发送')}
              </div>
              <div className="mt-0.5 text-xs text-text-secondary">
                {t(
                  'remote_workspace.dingtalk_download.send_via_robot_hint',
                  '机器人将文件发送到您的钉钉消息'
                )}
              </div>
            </div>
          </button>
        </div>

        <div className="flex justify-end pt-1">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('remote_workspace.actions.cancel', '取消')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
