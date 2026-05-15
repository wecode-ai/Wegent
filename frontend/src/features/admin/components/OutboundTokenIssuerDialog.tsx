// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { SigningKey } from '@/apis/admin'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import { Loader2 } from 'lucide-react'

import { InlineKeyFormState, IssuerFormState } from './OutboundTokenAdminTypes'

type OutboundTokenIssuerDialogProps = {
  open: boolean
  mode: 'create' | 'edit'
  issuerForm: IssuerFormState
  inlineKeyForm: InlineKeyFormState
  showInlineKeyForm: boolean
  signingKeysLoading: boolean
  signingKeysLoaded: boolean
  hasSelectableSigningKeys: boolean
  signingKeyOptions: SigningKey[]
  isSavingIssuer: boolean
  isCreatingInlineKey: boolean
  onOpenChange: (open: boolean) => void
  onIssuerFormChange: <K extends keyof IssuerFormState>(field: K, value: IssuerFormState[K]) => void
  onInlineKeyFormChange: <K extends keyof InlineKeyFormState>(
    field: K,
    value: InlineKeyFormState[K]
  ) => void
  onToggleInlineKeyForm: () => void
  onCreateInlineSigningKey: () => void
  onSave: () => void
}

const OutboundTokenIssuerDialog: React.FC<OutboundTokenIssuerDialogProps> = ({
  open,
  mode,
  issuerForm,
  inlineKeyForm,
  showInlineKeyForm,
  signingKeysLoading,
  signingKeysLoaded,
  hasSelectableSigningKeys,
  signingKeyOptions,
  isSavingIssuer,
  isCreatingInlineKey,
  onOpenChange,
  onIssuerFormChange,
  onInlineKeyFormChange,
  onToggleInlineKeyForm,
  onCreateInlineSigningKey,
  onSave,
}) => {
  const { t } = useTranslation('admin')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[620px] max-h-[90vh] overflow-y-auto bg-surface">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? t('outbound_tokens.issuers.create_dialog_title')
              : t('outbound_tokens.issuers.edit_dialog_title')}
          </DialogTitle>
          <DialogDescription>{t('outbound_tokens.issuers.dialog_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-primary">
                {t('outbound_tokens.common.name')}
              </label>
              <Input
                value={issuerForm.name}
                onChange={e => onIssuerFormChange('name', e.target.value)}
                placeholder={t('outbound_tokens.issuers.name_placeholder')}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-text-primary">
                {t('outbound_tokens.issuers.jwt_issuer')}
              </label>
              <Input
                value={issuerForm.issuer}
                onChange={e => onIssuerFormChange('issuer', e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium text-text-primary">
                {t('outbound_tokens.issuers.signing_key')}
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="px-2"
                onClick={onToggleInlineKeyForm}
              >
                {showInlineKeyForm
                  ? t('outbound_tokens.signing_keys.cancel_inline_create')
                  : t('outbound_tokens.signing_keys.inline_create')}
              </Button>
            </div>

            {signingKeysLoading && !signingKeysLoaded ? (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm text-text-muted flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('outbound_tokens.signing_keys.loading')}
              </div>
            ) : hasSelectableSigningKeys ? (
              <Select
                value={issuerForm.signingKeyId}
                onValueChange={value => onIssuerFormChange('signingKeyId', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('outbound_tokens.issuers.signing_key_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {signingKeyOptions.map(key => (
                    <SelectItem key={key.id} value={String(key.id)} disabled={!key.is_active}>
                      {key.name} ({key.kid})
                      {key.is_active ? '' : ` - ${t('outbound_tokens.common.status_disabled')}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-3 text-sm">
                <div className="font-medium text-text-primary">
                  {t('outbound_tokens.issuers.no_signing_keys_title')}
                </div>
                <p className="text-text-muted mt-1">
                  {t('outbound_tokens.issuers.no_signing_keys_description')}
                </p>
              </div>
            )}

            {showInlineKeyForm && (
              <div className="rounded-md border border-border bg-base p-3 space-y-3">
                <div className="text-sm font-medium text-text-primary">
                  {t('outbound_tokens.signing_keys.inline_create_title')}
                </div>
                <Input
                  value={inlineKeyForm.name}
                  onChange={e => onInlineKeyFormChange('name', e.target.value)}
                  placeholder={t('outbound_tokens.signing_keys.name_placeholder')}
                />
                <Textarea
                  value={inlineKeyForm.description}
                  onChange={e => onInlineKeyFormChange('description', e.target.value)}
                  placeholder={t('outbound_tokens.signing_keys.description_placeholder')}
                  rows={3}
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    onClick={onCreateInlineSigningKey}
                    disabled={isCreatingInlineKey}
                  >
                    {isCreatingInlineKey && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    {t('outbound_tokens.signing_keys.create')}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-primary">
                {t('outbound_tokens.issuers.audience')}
              </label>
              <Input
                value={issuerForm.audience}
                onChange={e => onIssuerFormChange('audience', e.target.value)}
                placeholder={t('outbound_tokens.issuers.audience_placeholder')}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-text-primary">
                {t('outbound_tokens.common.enabled')}
              </label>
              <div className="h-10 px-3 rounded-lg border border-border flex items-center justify-between">
                <span className="text-sm text-text-secondary">
                  {issuerForm.enabled
                    ? t('outbound_tokens.common.status_active')
                    : t('outbound_tokens.common.status_disabled')}
                </span>
                <Switch
                  checked={issuerForm.enabled}
                  onCheckedChange={checked => onIssuerFormChange('enabled', checked)}
                />
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-primary">
                {t('outbound_tokens.issuers.default_ttl')}
              </label>
              <Input
                type="number"
                min={60}
                value={issuerForm.defaultTtlSeconds}
                onChange={e => onIssuerFormChange('defaultTtlSeconds', e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-text-primary">
                {t('outbound_tokens.issuers.max_ttl')}
              </label>
              <Input
                type="number"
                min={60}
                value={issuerForm.maxTtlSeconds}
                onChange={e => onIssuerFormChange('maxTtlSeconds', e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-text-primary">
              {t('outbound_tokens.common.description')}
            </label>
            <Textarea
              value={issuerForm.description}
              onChange={e => onIssuerFormChange('description', e.target.value)}
              placeholder={t('outbound_tokens.common.description_placeholder')}
              rows={4}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSavingIssuer || isCreatingInlineKey}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={onSave}
            disabled={isSavingIssuer || isCreatingInlineKey}
            data-testid="save-outbound-token"
          >
            {isSavingIssuer && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {mode === 'create' ? t('common:actions.create') : t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default OutboundTokenIssuerDialog
