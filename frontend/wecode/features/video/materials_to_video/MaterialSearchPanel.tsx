// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ImageIcon, Loader2, Play } from 'lucide-react'
import Image from 'next/image'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { getAigcVideoImageUrl, getAigcVideoPlaybackUrl } from '../aigc_video/mediaUrls'
import { materialSearchApi } from './api'
import type { MaterialSearchResponse } from './types'
import { materialId, materialImageUrl, materialVideoUrl } from './utils'

interface MaterialSearchPanelProps {
  sessionId: string
  taskUuid: string
  onContinue?: (buttonName?: string) => void
}

export function MaterialSearchPanel({ sessionId, taskUuid, onContinue }: MaterialSearchPanelProps) {
  const { t } = useTranslation('video')
  const { toast } = useToast()
  const [result, setResult] = useState<MaterialSearchResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const selectionInitializedRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const response = await materialSearchApi.get(sessionId, taskUuid)
      setResult(response)
      if (!selectionInitializedRef.current) {
        setSelected(
          new Set(
            response.selected_material_ids?.length
              ? response.selected_material_ids
              : response.materials.map((material, index) => materialId(material, index))
          )
        )
        selectionInitializedRef.current = true
      }
      return response.selection_status
    } catch (error) {
      toast({
        variant: 'destructive',
        description:
          error instanceof Error ? error.message : t('materialEditor.materials.loadFailed'),
      })
      return undefined
    } finally {
      setLoading(false)
    }
  }, [sessionId, t, taskUuid, toast])

  useEffect(() => {
    let timer: number | undefined
    let disposed = false
    const refresh = async () => {
      const status = await load()
      if (!disposed && status === 'searching') timer = window.setTimeout(refresh, 3000)
    }
    void refresh()
    return () => {
      disposed = true
      if (timer) window.clearTimeout(timer)
    }
  }, [load])

  const selectedMaterials = useMemo(
    () =>
      result?.materials.filter((material, index) => selected.has(materialId(material, index))) ??
      [],
    [result, selected]
  )

  const confirm = async () => {
    if (!result || selectedMaterials.length === 0) return
    setSaving(true)
    try {
      await materialSearchApi.confirm(sessionId, taskUuid, selectedMaterials)
      toast({ description: t('materialEditor.materials.confirmed') })
      onContinue?.(result.buttons?.[0]?.button_name)
    } catch (error) {
      toast({
        variant: 'destructive',
        description:
          error instanceof Error ? error.message : t('materialEditor.materials.saveFailed'),
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading && !result) {
    return (
      <div
        className="flex min-h-48 items-center justify-center"
        data-testid="material-search-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    )
  }

  if (!result) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-text-secondary">
        <span>{t('materialEditor.materials.loadFailed')}</span>
        <Button variant="outline" onClick={() => void load()} data-testid="material-search-retry">
          {t('materialEditor.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="material-search-panel">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {result.selection_status === 'searching' ? (
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-primary/5 px-3 py-2 text-sm text-primary">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('materialEditor.materials.searching')}
          </div>
        ) : null}
        {result.error_message ? (
          <div className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {result.error_message}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {result.materials.map((material, index) => {
            const id = materialId(material, index)
            const imageUrl = getAigcVideoImageUrl(materialImageUrl(material))
            const videoUrl = materialVideoUrl(material)
            const checked = selected.has(id)
            return (
              <label
                key={id}
                className={`cursor-pointer overflow-hidden rounded-lg border transition-colors ${
                  checked ? 'border-primary bg-primary/5' : 'border-border bg-surface'
                }`}
                data-testid={`material-search-item-${id}`}
              >
                <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-muted">
                  {imageUrl ? (
                    <Image
                      src={imageUrl}
                      alt=""
                      fill
                      unoptimized
                      sizes="(min-width: 640px) 320px, 100vw"
                      className="object-cover"
                    />
                  ) : videoUrl ? (
                    <video
                      src={getAigcVideoPlaybackUrl(videoUrl)}
                      className="h-full w-full object-cover"
                      preload="metadata"
                    />
                  ) : (
                    <ImageIcon className="h-8 w-8 text-text-secondary" />
                  )}
                  {material.type === 'video' ? (
                    <span className="absolute bottom-2 right-2 rounded-full bg-black/60 p-1.5 text-white">
                      <Play className="h-3.5 w-3.5 fill-current" />
                    </span>
                  ) : null}
                </div>
                <div className="flex items-start gap-3 p-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setSelected(current => {
                        const next = new Set(current)
                        if (next.has(id)) next.delete(id)
                        else next.add(id)
                        return next
                      })
                    }
                    className="mt-0.5 h-4 w-4 accent-primary"
                    data-testid={`material-search-checkbox-${id}`}
                  />
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-sm font-medium">
                      {material.title || material.text || material.content || id}
                    </div>
                    {material.reason ? (
                      <div className="mt-1 line-clamp-2 text-xs text-text-secondary">
                        {material.reason}
                      </div>
                    ) : null}
                  </div>
                </div>
              </label>
            )
          })}
        </div>
        {result.materials.length === 0 && result.selection_status !== 'searching' ? (
          <div className="flex min-h-48 items-center justify-center text-sm text-text-secondary">
            {t('materialEditor.materials.empty')}
          </div>
        ) : null}
      </div>
      <footer className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3">
        <span className="text-sm text-text-secondary">
          {t('materialEditor.materials.selected', { count: selectedMaterials.length })}
        </span>
        <Button
          variant="primary"
          onClick={() => void confirm()}
          disabled={
            saving || selectedMaterials.length === 0 || result.selection_status === 'searching'
          }
          data-testid="material-search-confirm"
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {result.buttons?.[0]?.button_name || t('materialEditor.materials.confirm')}
        </Button>
      </footer>
    </div>
  )
}
