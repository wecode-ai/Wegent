// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'

const PROMPT_HINT_COOLDOWN_KEY = 'pet-prompt-hint-last'
const PROMPT_HINT_COOLDOWN_MS = 10 * 60 * 1000
const PROMPT_HINT_DELAY_MS = 2000
const PROMPT_HINT_VISIBLE_MS = 6000
const PROMPT_HINT_DISPLAY_RATE = 0.35

export function usePromptDraftHint(taskId: number | null) {
  const [showPromptHint, setShowPromptHint] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !taskId) {
      setShowPromptHint(false)
      return
    }

    const lastShownRaw = localStorage.getItem(PROMPT_HINT_COOLDOWN_KEY)
    const lastShown = lastShownRaw ? Number(lastShownRaw) : 0
    if (Date.now() - lastShown < PROMPT_HINT_COOLDOWN_MS) {
      setShowPromptHint(false)
      return
    }

    let hideTimer: number | null = null
    const showTimer = window.setTimeout(() => {
      if (Math.random() >= PROMPT_HINT_DISPLAY_RATE) return
      setShowPromptHint(true)
      localStorage.setItem(PROMPT_HINT_COOLDOWN_KEY, String(Date.now()))
      hideTimer = window.setTimeout(() => setShowPromptHint(false), PROMPT_HINT_VISIBLE_MS)
    }, PROMPT_HINT_DELAY_MS)

    return () => {
      window.clearTimeout(showTimer)
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer)
      }
    }
  }, [taskId])

  return showPromptHint
}
