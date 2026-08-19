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

const DEFAULT_PROFILE: RetrievalConfigDraft = {
  retriever_namespace: 'default',
  embedding_config: { model_namespace: 'default' },
  retrieval_mode: 'vector',
  top_k: 5,
  score_threshold: 0.5,
  hybrid_weights: { vector_weight: 0.7, keyword_weight: 0.3 },
}

export function CodeWikiRetrievalProfileSection() {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [profile, setProfile] = useState<RetrievalConfigDraft>(DEFAULT_PROFILE)
  const [health, setHealth] = useState<'missing' | 'valid' | 'invalid'>('missing')
  const [fallbackReason, setFallbackReason] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void adminApis.getCodeWikiRetrievalProfile().then(response => {
      if (response.retrieval_config) setProfile(response.retrieval_config)
      setHealth(response.health.status)
      setFallbackReason(response.health.fallback_reason)
    })
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const response = await adminApis.updateCodeWikiRetrievalProfile(profile)
      setHealth(response.health.status)
      setFallbackReason(response.health.fallback_reason)
      toast({ title: t('system_config.code_wiki_profile_saved') })
    } catch {
      toast({ title: t('system_config.code_wiki_profile_save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <CollapsibleSection
      title={t('system_config.code_wiki_profile_title')}
      defaultOpen={false}
      className="mb-0"
      triggerTestId="code-wiki-retrieval-profile-toggle"
    >
      <p className="text-sm text-text-muted">{t('system_config.code_wiki_profile_description')}</p>
      <RetrievalSettingsSection config={profile} onChange={setProfile} scope="all" publicOnly />
      <p className={health === 'valid' ? 'text-sm text-success' : 'text-sm text-warning'}>
        {t(`system_config.code_wiki_profile_health_${health}`)}
        {fallbackReason ? ` ${fallbackReason}` : ''}
      </p>
      <Button
        type="button"
        variant="primary"
        onClick={save}
        disabled={saving}
        data-testid="save-code-wiki-retrieval-profile"
      >
        {t('common:actions.save')}
      </Button>
    </CollapsibleSection>
  )
}
