'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Basic Info Section - Name, Description, Enabled, Visibility
 */

import { Eye, EyeOff, FileText } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import { CollapsibleSection } from '@/components/common/CollapsibleSection'
import type { SearchUser } from '@/types/api'
import type { MetaInfoSectionProps } from './types'

export function BasicInfoSection({
  displayName,
  setDisplayName,
  description,
  setDescription,
  enabled,
  setEnabled,
  visibility,
  setVisibility,
  marketWhitelistUsers,
  setMarketWhitelistUsers,
  isRental,
}: MetaInfoSectionProps) {
  const { t } = useTranslation('feed')

  return (
    <CollapsibleSection
      title={t('basic_info') || '基本信息'}
      icon={<FileText className="h-4 w-4 text-primary" />}
      defaultOpen={true}
    >
      {/* Display Name */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t('display_name')} <span className="text-destructive">*</span>
        </Label>
        <Input
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          placeholder={t('display_name_placeholder')}
          className="h-10"
        />
      </div>

      {/* Description */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t('description')}</Label>
        <Input
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder={t('description_placeholder')}
          className="h-10"
        />
      </div>

      {/* Enabled */}
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{t('enable_subscription')}</Label>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {/* Visibility - Hidden for rental subscriptions */}
      {!isRental && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t('visibility')}</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={visibility === 'private' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setVisibility('private')}
              className="flex-1"
            >
              <EyeOff className="h-4 w-4 mr-1.5" />
              {t('visibility_private')}
            </Button>
            <Button
              type="button"
              variant={visibility === 'public' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setVisibility('public')}
              className="flex-1"
            >
              <Eye className="h-4 w-4 mr-1.5" />
              {t('visibility_public')}
            </Button>
            <Button
              type="button"
              variant={visibility === 'market' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setVisibility('market')}
              className="flex-1"
            >
              <Eye className="h-4 w-4 mr-1.5" />
              {t('visibility_market')}
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            {visibility === 'private'
              ? t('visibility_private_hint')
              : visibility === 'market'
                ? t('visibility_market_hint')
                : t('visibility_public_hint')}
          </p>
        </div>
      )}

      {/* Market whitelist - only shown for market subscriptions */}
      {!isRental && visibility === 'market' && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t('market_whitelist')}</Label>
          <UserSearchSelect<SearchUser>
            selectedUsers={marketWhitelistUsers}
            onSelectedUsersChange={setMarketWhitelistUsers}
            placeholder={t('market_whitelist_search_placeholder')}
          />
          <p className="text-xs text-text-muted">{t('market_whitelist_hint')}</p>
        </div>
      )}
    </CollapsibleSection>
  )
}
