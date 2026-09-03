// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { KeyRound, Key, ShieldCheck, AppWindow, PackageCheck } from 'lucide-react'
import ServiceKeyList from './ServiceKeyList'
import PluginReleaseKeyList from './PluginReleaseKeyList'
import PersonalKeyList from './PersonalKeyList'
import OutboundTokenIssuerList from './OutboundTokenIssuerList'
import OAuthClientManagement from '@/features/settings/components/OAuthClientManagement'

type KeyType = 'service' | 'plugin-release' | 'personal' | 'outbound' | 'oauth'

const ApiKeyManagement: React.FC = () => {
  const { t } = useTranslation('admin')
  const [activeKeyType, setActiveKeyType] = useState<KeyType>('service')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary mb-1">{t('api_keys.title')}</h2>
          <p className="text-sm text-text-muted">{t('api_keys.description')}</p>
        </div>
      </div>

      <div className="flex w-full flex-wrap gap-2 rounded-lg bg-muted p-1 sm:w-fit">
        <Button
          variant={activeKeyType === 'service' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setActiveKeyType('service')}
          className="gap-2"
        >
          <KeyRound className="w-4 h-4" />
          {t('api_keys.service_keys')}
        </Button>
        <Button
          variant={activeKeyType === 'plugin-release' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setActiveKeyType('plugin-release')}
          className="gap-2"
          data-testid="plugin-release-keys-tab-button"
        >
          <PackageCheck className="w-4 h-4" />
          {t('api_keys.plugin_release_keys')}
        </Button>
        <Button
          variant={activeKeyType === 'personal' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setActiveKeyType('personal')}
          className="gap-2"
        >
          <Key className="w-4 h-4" />
          {t('api_keys.personal_keys')}
        </Button>
        <Button
          variant={activeKeyType === 'outbound' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setActiveKeyType('outbound')}
          className="gap-2"
          data-testid="outbound-tab-button"
        >
          <ShieldCheck className="w-4 h-4" />
          {t('api_keys.outbound_tokens')}
        </Button>
        <Button
          variant={activeKeyType === 'oauth' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setActiveKeyType('oauth')}
          className="gap-2"
          data-testid="oauth-clients-tab-button"
        >
          <AppWindow className="w-4 h-4" />
          {t('api_keys.oauth_clients')}
        </Button>
      </div>

      <div className="mt-4">
        {activeKeyType === 'service' && <ServiceKeyList showHeader={false} />}
        {activeKeyType === 'plugin-release' && <PluginReleaseKeyList showHeader={false} />}
        {activeKeyType === 'personal' && <PersonalKeyList showHeader={false} />}
        {activeKeyType === 'outbound' && <OutboundTokenIssuerList showHeader={false} />}
        {activeKeyType === 'oauth' && <OAuthClientManagement mode="admin" />}
      </div>
    </div>
  )
}

export default ApiKeyManagement
