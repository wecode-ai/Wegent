// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback } from 'react'
import { listTemplates, type Template } from '@/apis/template'

interface UseTemplatesOptions {
  category?: string
  autoLoad?: boolean
}

export function useTemplates({ category, autoLoad = true }: UseTemplatesOptions = {}) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await listTemplates(category)
      setTemplates(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates')
    } finally {
      setLoading(false)
    }
  }, [category])

  useEffect(() => {
    if (autoLoad) {
      fetchTemplates()
    }
  }, [autoLoad, fetchTemplates])

  return { templates, loading, error, refresh: fetchTemplates }
}
