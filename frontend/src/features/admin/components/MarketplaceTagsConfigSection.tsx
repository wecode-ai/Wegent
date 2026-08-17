// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import { PlusIcon } from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'

import { adminApis } from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { MarketplaceTag } from '@/types/marketplace'

function createEmptyTag(index: number): MarketplaceTag {
  return {
    id: `new_tag_${index + 1}`,
    name_zh: '',
    name_en: '',
    sort: (index + 1) * 10,
    enabled: true,
  }
}

export function MarketplaceTagsConfigSection() {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const tRef = useRef(t)
  const toastRef = useRef(toast)
  tRef.current = t
  toastRef.current = toast
  const [items, setItems] = useState<MarketplaceTag[]>([])
  const [persistedIds, setPersistedIds] = useState<Set<string>>(new Set())
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    adminApis
      .getMarketplaceTagsConfig()
      .then(response => {
        if (!active) return
        setItems(response.items)
        setPersistedIds(new Set(response.items.map(item => item.id)))
        setVersion(response.version)
      })
      .catch(() => {
        if (active) {
          toastRef.current({
            title: tRef.current('system_config.marketplace_tags_load_failed'),
            variant: 'destructive',
          })
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const updateItem = (index: number, patch: Partial<MarketplaceTag>) => {
    setItems(current =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))
    )
  }

  const handleSave = async () => {
    if (items.some(item => !item.id.trim() || !item.name_zh.trim() || !item.name_en.trim())) {
      toast({
        title: t('system_config.marketplace_tags_required'),
        variant: 'destructive',
      })
      return
    }
    setSaving(true)
    try {
      const response = await adminApis.updateMarketplaceTagsConfig({
        expected_version: version,
        items,
      })
      setItems(response.items)
      setPersistedIds(new Set(response.items.map(item => item.id)))
      setVersion(response.version)
      toast({ title: t('system_config.marketplace_tags_saved') })
    } catch (error) {
      toast({
        title: t('system_config.marketplace_tags_save_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="p-6" data-testid="marketplace-tags-config-section">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-md font-medium text-text-primary">
            {t('system_config.marketplace_tags_title')}
          </h3>
          <p className="mt-1 text-sm text-text-muted">
            {t('system_config.marketplace_tags_description')}
          </p>
          <p className="mt-2 text-xs text-text-muted">
            {t('system_config.version')}: {version}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setItems(current => [...current, createEmptyTag(current.length)])}
            disabled={loading || items.length >= 30}
            data-testid="marketplace-tags-add"
          >
            <PlusIcon className="h-4 w-4" />
            {t('system_config.marketplace_tags_add')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={loading || saving}
            data-testid="marketplace-tags-save"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('common:actions.save')}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-text-muted">{t('system_config.loading')}</div>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => (
            <div
              key={`${item.id}-${index}`}
              className="grid gap-3 rounded-md border border-border bg-base p-3 md:grid-cols-[1fr_1fr_1fr_100px_auto]"
              data-testid={`marketplace-tag-config-row-${index}`}
            >
              <Input
                value={item.id}
                onChange={event => updateItem(index, { id: event.target.value })}
                disabled={persistedIds.has(item.id)}
                placeholder={t('system_config.marketplace_tag_id')}
                data-testid={`marketplace-tag-id-${index}`}
              />
              <Input
                value={item.name_zh}
                onChange={event => updateItem(index, { name_zh: event.target.value })}
                placeholder={t('system_config.marketplace_tag_name_zh')}
                data-testid={`marketplace-tag-name-zh-${index}`}
              />
              <Input
                value={item.name_en}
                onChange={event => updateItem(index, { name_en: event.target.value })}
                placeholder={t('system_config.marketplace_tag_name_en')}
                data-testid={`marketplace-tag-name-en-${index}`}
              />
              <Input
                type="number"
                value={item.sort}
                onChange={event => updateItem(index, { sort: Number(event.target.value) })}
                placeholder={t('system_config.marketplace_tag_sort')}
                data-testid={`marketplace-tag-sort-${index}`}
              />
              <div className="flex min-h-10 items-center gap-2">
                <Switch
                  checked={item.enabled}
                  onCheckedChange={enabled => updateItem(index, { enabled })}
                  data-testid={`marketplace-tag-enabled-${index}`}
                />
                <span className="text-sm text-text-muted">
                  {item.enabled
                    ? t('system_config.marketplace_tag_enabled')
                    : t('system_config.marketplace_tag_disabled')}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
