// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { LinkIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import type { MarketplaceTeam, InstallMode } from '@/types/marketplace'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface InstallModeDialogProps {
  open: boolean
  onClose: () => void
  team: MarketplaceTeam
  onInstall: (mode: InstallMode) => void
  isInstalling: boolean
}

export function InstallModeDialog({
  open,
  onClose,
  team,
  onInstall,
  isInstalling,
}: InstallModeDialogProps) {
  const { t } = useTranslation('marketplace')
  const [selectedMode, setSelectedMode] = useState<InstallMode>(
    team.allow_reference ? 'reference' : 'copy'
  )

  const handleInstall = () => {
    onInstall(selectedMode)
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('install_mode.title')}</DialogTitle>
          <DialogDescription>
            {t('install_mode.description', { name: team.name })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-4">
          {/* Reference mode option */}
          {team.allow_reference && (
            <button
              type="button"
              onClick={() => setSelectedMode('reference')}
              className={`w-full p-4 rounded-lg border-2 text-left transition-colors ${
                selectedMode === 'reference'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50'
              }`}
            >
              <div className="flex items-start gap-3">
                <LinkIcon className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <h4 className="font-medium text-text-primary">{t('install_mode.reference')}</h4>
                  <p className="text-sm text-text-muted mt-1">
                    {t('install_mode.reference_desc')}
                  </p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                    selectedMode === 'reference' ? 'border-primary' : 'border-border'
                  }`}
                >
                  {selectedMode === 'reference' && (
                    <div className="w-2.5 h-2.5 rounded-full bg-primary" />
                  )}
                </div>
              </div>
            </button>
          )}

          {/* Copy mode option */}
          {team.allow_copy && (
            <button
              type="button"
              onClick={() => setSelectedMode('copy')}
              className={`w-full p-4 rounded-lg border-2 text-left transition-colors ${
                selectedMode === 'copy'
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50'
              }`}
            >
              <div className="flex items-start gap-3">
                <DocumentDuplicateIcon className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <h4 className="font-medium text-text-primary">{t('install_mode.copy')}</h4>
                  <p className="text-sm text-text-muted mt-1">{t('install_mode.copy_desc')}</p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                    selectedMode === 'copy' ? 'border-primary' : 'border-border'
                  }`}
                >
                  {selectedMode === 'copy' && (
                    <div className="w-2.5 h-2.5 rounded-full bg-primary" />
                  )}
                </div>
              </div>
            </button>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={isInstalling}>
            {t('common:common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleInstall} disabled={isInstalling}>
            {isInstalling ? t('installing') : t('install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
