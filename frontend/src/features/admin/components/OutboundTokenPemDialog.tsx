// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline'

import { PemTarget } from './OutboundTokenAdminTypes'

type OutboundTokenPemDialogProps = {
  pemTarget: PemTarget | null
  copiedPemTarget: string | null
  onOpenChange: (open: boolean) => void
  onCopy: (pem: string, target: string) => void
}

const OutboundTokenPemDialog: React.FC<OutboundTokenPemDialogProps> = ({
  pemTarget,
  copiedPemTarget,
  onOpenChange,
  onCopy,
}) => {
  const { t } = useTranslation('admin')

  return (
    <Dialog open={!!pemTarget} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px] bg-surface">
        <DialogHeader>
          <DialogTitle>{pemTarget?.title}</DialogTitle>
          <DialogDescription>
            {t('outbound_tokens.pem_dialog.description', {
              name: pemTarget?.name,
              kid: pemTarget?.kid,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Textarea
            value={pemTarget?.publicKeyPem || ''}
            readOnly
            rows={12}
            className="font-mono text-xs"
          />
          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={() =>
                pemTarget && onCopy(pemTarget.publicKeyPem, `${pemTarget.name}:${pemTarget.kid}`)
              }
              data-testid="copy-outbound-token"
            >
              {copiedPemTarget === `${pemTarget?.name}:${pemTarget?.kid}` ? (
                <CheckIcon className="w-4 h-4 mr-2" />
              ) : (
                <ClipboardDocumentIcon className="w-4 h-4 mr-2" />
              )}
              {t('outbound_tokens.actions.copy_pem')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default OutboundTokenPemDialog
