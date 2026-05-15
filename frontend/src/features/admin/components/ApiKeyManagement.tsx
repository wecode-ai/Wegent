// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { KeyRound, Key, ShieldCheck } from 'lucide-react'
import ServiceKeyList from './ServiceKeyList'
import PersonalKeyList from './PersonalKeyList'
import OutboundTokenIssuerList from './OutboundTokenIssuerList'

type KeyType = 'service' | 'personal' | 'outbound'

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

      <div className="flex gap-2 p-1 bg-muted rounded-lg w-fit">
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
      </div>

      <div className="mt-4">
        {activeKeyType === 'service' && <ServiceKeyList showHeader={false} />}
        {activeKeyType === 'personal' && <PersonalKeyList showHeader={false} />}
        {activeKeyType === 'outbound' && <OutboundTokenIssuerList showHeader={false} />}
      </div>
    </div>
  )
}

export default ApiKeyManagement
