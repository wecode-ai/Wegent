// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Global kill-switch flag for the multimodal (video/image Gemini) pipeline.
 *
 * Mirrors the backend `KNOWLEDGE_MULTIMODAL_ENABLED` setting (exposed via the
 * `/knowledge-bases/multimodal-default-prompts` `enabled` field). When false,
 * callers hide the entire multimodal UI so users never configure or trigger a
 * disabled pipeline.
 *
 * The flag is fetched once and cached at module scope (shared across every
 * component that calls this hook) so opening multiple KB dialogs / the upload
 * dialog does not re-issue the request.
 */

import { useEffect, useState } from 'react'
import { getMultimodalDefaultPrompts } from '@/apis/knowledge'

// Module-scope cache so the switch is fetched at most once per page session.
let _enabledCache: boolean | null = null
let _enabledPromise: Promise<boolean> | null = null

function fetchEnabled(): Promise<boolean> {
  if (_enabledPromise) return _enabledPromise
  _enabledPromise = getMultimodalDefaultPrompts()
    .then(d => {
      _enabledCache = d.enabled !== false
      return _enabledCache
    })
    .catch(() => {
      // On fetch failure default to disabled — safer than exposing a pipeline
      // whose availability is unknown.
      _enabledCache = false
      return false
    })
    .finally(() => {
      _enabledPromise = null
    })
  return _enabledPromise
}

/**
 * Returns whether the multimodal pipeline is globally enabled.
 *
 * Defaults to `false` while loading (the switch defaults to off on the backend,
 * so a brief false-before-resolve avoids a flash of multimodal UI when the
 * switch is actually off). Resolves to the cached backend value after mount.
 */
export function useMultimodalFeatureEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(_enabledCache ?? false)

  useEffect(() => {
    if (_enabledCache !== null) {
      setEnabled(_enabledCache)
      return
    }
    let mounted = true
    fetchEnabled().then(e => {
      if (mounted) setEnabled(e)
    })
    return () => {
      mounted = false
    }
  }, [])

  return enabled
}
