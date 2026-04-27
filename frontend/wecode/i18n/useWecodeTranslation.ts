// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { translateWecodeKey } from './wecodeTranslation'

export function useWecodeTranslation() {
  const { t, i18n } = useTranslation('wecode')

  const translate = useCallback(
    (key: string, options?: Record<string, unknown>) =>
      translateWecodeKey(key, t(key, options), i18n.language, options),
    [i18n.language, t]
  )

  return {
    t: translate,
    i18n,
  }
}
