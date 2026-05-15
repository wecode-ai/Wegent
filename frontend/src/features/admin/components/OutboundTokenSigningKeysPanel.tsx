// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { SigningKey } from '@/apis/admin'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'
import { EyeIcon, TrashIcon } from '@heroicons/react/24/outline'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'

type OutboundTokenSigningKeysPanelProps = {
  showSigningKeys: boolean
  signingKeysLoading: boolean
  signingKeysLoaded: boolean
  signingKeys: SigningKey[]
  usageCounts: Map<number, number>
  togglingKeyId: number | null
  onTogglePanel: () => void
  onViewPem: (key: SigningKey) => void
  onToggle: (key: SigningKey) => void
  onDelete: (key: SigningKey) => void
}

const OutboundTokenSigningKeysPanel: React.FC<OutboundTokenSigningKeysPanelProps> = ({
  showSigningKeys,
  signingKeysLoading,
  signingKeysLoaded,
  signingKeys,
  usageCounts,
  togglingKeyId,
  onTogglePanel,
  onViewPem,
  onToggle,
  onDelete,
}) => {
  const { t } = useTranslation('admin')

  return (
    <Card className="p-4 bg-base">
      <button
        type="button"
        className="w-full flex items-center justify-between text-left"
        onClick={onTogglePanel}
      >
        <div>
          <div className="font-medium text-text-primary">
            {t('outbound_tokens.signing_keys.section_title')}
          </div>
          <p className="text-sm text-text-muted mt-1">
            {t('outbound_tokens.signing_keys.section_description')}
          </p>
        </div>
        <div className="flex items-center gap-2 text-text-muted">
          {signingKeysLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : signingKeysLoaded ? (
            <Badge variant="info" size="sm">
              {signingKeys.length}
            </Badge>
          ) : null}
          {showSigningKeys ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </div>
      </button>

      {showSigningKeys && (
        <div className="mt-4 space-y-3">
          {signingKeysLoading && !signingKeysLoaded && (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('outbound_tokens.signing_keys.loading')}
            </div>
          )}

          {signingKeysLoaded && signingKeys.length === 0 && (
            <p className="text-sm text-text-muted">{t('outbound_tokens.signing_keys.no_keys')}</p>
          )}

          {signingKeysLoaded &&
            signingKeys.map(key => (
              <div
                key={key.id}
                className={`rounded-md border border-border p-3 ${key.is_active ? 'bg-base' : 'bg-muted/40'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text-primary">{key.name}</span>
                      <Badge variant={key.is_active ? 'success' : 'secondary'} size="sm">
                        {key.is_active
                          ? t('outbound_tokens.common.status_active')
                          : t('outbound_tokens.common.status_disabled')}
                      </Badge>
                    </div>
                    {key.description && (
                      <p className="text-sm text-text-muted mt-1">{key.description}</p>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted mt-2">
                      <span>
                        {t('outbound_tokens.signing_keys.kid')}: <code>{key.kid}</code>
                      </span>
                      <span>
                        {t('outbound_tokens.signing_keys.algorithm')}: {key.algorithm}
                      </span>
                      <span>
                        {t('outbound_tokens.signing_keys.usage_count')}:{' '}
                        {usageCounts.get(key.id) ?? 0}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 min-w-[44px]"
                      onClick={() => onViewPem(key)}
                      title={t('outbound_tokens.actions.view_pem')}
                    >
                      <EyeIcon className="w-4 h-4" />
                    </Button>
                    <Switch
                      checked={key.is_active}
                      onCheckedChange={() => onToggle(key)}
                      disabled={togglingKeyId === key.id}
                      title={
                        key.is_active
                          ? t('outbound_tokens.actions.disable')
                          : t('outbound_tokens.actions.enable')
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 min-w-[44px] hover:text-error"
                      onClick={() => onDelete(key)}
                      title={t('common:actions.delete')}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}
    </Card>
  )
}

export default OutboundTokenSigningKeysPanel
