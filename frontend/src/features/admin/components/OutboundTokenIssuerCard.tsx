// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/hooks/useTranslation'
import { TokenIssuer } from '@/apis/admin'
import { EyeIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/outline'

type OutboundTokenIssuerCardProps = {
  issuer: TokenIssuer
  togglingIssuerId: number | null
  formatDate: (dateString: string) => string
  formatTtl: (seconds: number) => string
  onViewPem: (issuer: TokenIssuer) => void
  onEdit: (issuer: TokenIssuer) => void
  onToggle: (issuer: TokenIssuer) => void
  onDelete: (issuer: TokenIssuer) => void
}

const OutboundTokenIssuerCard: React.FC<OutboundTokenIssuerCardProps> = ({
  issuer,
  togglingIssuerId,
  formatDate,
  formatTtl,
  onViewPem,
  onEdit,
  onToggle,
  onDelete,
}) => {
  const { t } = useTranslation('admin')

  return (
    <Card
      className={`p-4 bg-base hover:bg-hover transition-colors ${!issuer.is_active ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text-primary">{issuer.name}</span>
            <Badge variant={issuer.is_active ? 'success' : 'secondary'} size="sm">
              {issuer.is_active
                ? t('outbound_tokens.common.status_active')
                : t('outbound_tokens.common.status_disabled')}
            </Badge>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-text-secondary">
              issuer_id={issuer.id}
            </code>
          </div>

          {issuer.description && <p className="text-sm text-text-muted">{issuer.description}</p>}

          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
              {t('outbound_tokens.issuers.current_signing_key')}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-primary">
              <span className="font-medium">{issuer.signing_key_name}</span>
              <code className="text-xs bg-base px-1.5 py-0.5 rounded text-text-secondary">
                {issuer.signing_key_kid}
              </code>
              <span className="text-text-muted">
                {t('outbound_tokens.issuers.signing_key_hint')}
              </span>
            </div>
          </div>

          <div className="grid gap-2 text-sm text-text-secondary md:grid-cols-2">
            <div>
              <span className="text-text-muted">{t('outbound_tokens.issuers.audience')}:</span>{' '}
              <code>{issuer.audience}</code>
            </div>
            <div>
              <span className="text-text-muted">{t('outbound_tokens.issuers.jwt_issuer')}:</span>{' '}
              <code>{issuer.issuer}</code>
            </div>
            <div>
              <span className="text-text-muted">{t('outbound_tokens.issuers.default_ttl')}:</span>{' '}
              {formatTtl(issuer.default_ttl_seconds)}
            </div>
            <div>
              <span className="text-text-muted">{t('outbound_tokens.issuers.max_ttl')}:</span>{' '}
              {formatTtl(issuer.max_ttl_seconds)}
            </div>
            <div className="md:col-span-2">
              <span className="text-text-muted">{t('outbound_tokens.common.created_at')}:</span>{' '}
              {formatDate(issuer.created_at)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 min-w-[44px]"
            onClick={() => onViewPem(issuer)}
            title={t('outbound_tokens.actions.view_pem')}
            data-testid="view-outbound-token"
          >
            <EyeIcon className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 min-w-[44px]"
            onClick={() => onEdit(issuer)}
            title={t('outbound_tokens.actions.edit')}
            data-testid="edit-outbound-token"
          >
            <PencilSquareIcon className="w-4 h-4" />
          </Button>
          <Switch
            checked={issuer.is_active}
            onCheckedChange={() => onToggle(issuer)}
            disabled={togglingIssuerId === issuer.id}
            title={
              issuer.is_active
                ? t('outbound_tokens.actions.disable')
                : t('outbound_tokens.actions.enable')
            }
            data-testid="toggle-outbound-token"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-11 min-w-[44px] hover:text-error"
            onClick={() => onDelete(issuer)}
            title={t('common:actions.delete')}
            data-testid="delete-outbound-token"
          >
            <TrashIcon className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Card>
  )
}

export default OutboundTokenIssuerCard
