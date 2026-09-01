// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { AppWindow, Key } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

import ApiKeyList from './ApiKeyList'
import OAuthClientManagement from './OAuthClientManagement'

type CredentialType = 'api-key' | 'oauth'

export default function DeveloperCredentials() {
  const { t } = useTranslation('settings')
  const [activeType, setActiveType] = useState<CredentialType>('api-key')

  return (
    <div className="space-y-4">
      <div className="flex w-full flex-wrap gap-2 rounded-lg bg-muted p-1 sm:w-fit">
        <Button
          variant={activeType === 'api-key' ? 'default' : 'ghost'}
          size="sm"
          className="min-h-11 gap-2"
          onClick={() => setActiveType('api-key')}
          data-testid="developer-api-keys-tab"
        >
          <Key className="h-4 w-4" />
          {t('developer_credentials.api_keys')}
        </Button>
        <Button
          variant={activeType === 'oauth' ? 'default' : 'ghost'}
          size="sm"
          className="min-h-11 gap-2"
          onClick={() => setActiveType('oauth')}
          data-testid="developer-oauth-apps-tab"
        >
          <AppWindow className="h-4 w-4" />
          {t('developer_credentials.oauth_apps')}
        </Button>
      </div>

      {activeType === 'api-key' ? <ApiKeyList /> : <OAuthClientManagement />}
    </div>
  )
}
