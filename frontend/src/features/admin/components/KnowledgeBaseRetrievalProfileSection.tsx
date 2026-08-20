// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CollapsibleSection } from '@/components/common/CollapsibleSection'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { adminApis } from '@/apis/admin'
import type { RetrievalConfigDraft } from '@/types/knowledge'
import { RetrievalSettingsSection } from '@/features/knowledge/document/components/RetrievalSettingsSection'
import { createDefaultRetrievalProfile } from '@/features/knowledge/document/components/retrievalConfig'

export function KnowledgeBaseRetrievalProfileSection() {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [profile, setProfile] = useState<RetrievalConfigDraft>(createDefaultRetrievalProfile)
  const [health, setHealth] = useState<'missing' | 'valid' | 'invalid'>('missing')
  const [fallbackReason, setFallbackReason] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void adminApis
      .getKnowledgeBaseRetrievalProfile()
      .then(response => {
        if (response.retrieval_config) setProfile(response.retrieval_config)
        setHealth(response.health.status)
        setFallbackReason(response.health.fallback_reason)
        setLoadState('ready')
      })
      .catch(() => setLoadState('error'))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const response = await adminApis.updateKnowledgeBaseRetrievalProfile(profile)
      setHealth(response.health.status)
      setFallbackReason(response.health.fallback_reason)
      toast({ title: t('system_config.knowledge_base_profile_saved') })
    } catch {
      toast({
        title: t('system_config.knowledge_base_profile_save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <CollapsibleSection
      title={t('system_config.knowledge_base_profile_title')}
      defaultOpen={false}
      className="mb-0"
      triggerTestId="knowledge-base-retrieval-profile-toggle"
    >
      <p className="text-sm text-text-muted">
        {t('system_config.knowledge_base_profile_description')}
      </p>
      <RetrievalSettingsSection config={profile} onChange={setProfile} scope="all" publicOnly />
      <p className={health === 'valid' ? 'text-sm text-success' : 'text-sm text-warning'}>
        {t(
          loadState === 'error'
            ? 'system_config.knowledge_base_profile_load_failed'
            : `system_config.knowledge_base_profile_health_${health}`
        )}
        {fallbackReason ? ` ${t(`system_config.retrieval_profile_reason_${fallbackReason}`)}` : ''}
      </p>
      <Button
        type="button"
        variant="primary"
        className="h-11"
        onClick={save}
        disabled={saving || loadState !== 'ready'}
        data-testid="save-knowledge-base-retrieval-profile"
      >
        {t('common:actions.save')}
      </Button>
    </CollapsibleSection>
  )
}
