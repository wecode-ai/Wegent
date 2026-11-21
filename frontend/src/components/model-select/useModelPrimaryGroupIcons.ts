// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'
import {
  getModelPrimaryGroupIcons,
  type ModelPrimaryGroupIcons,
} from '@/apis/model-primary-group-icons'

export function useModelPrimaryGroupIcons(enabled: boolean) {
  const [icons, setIcons] = useState<ModelPrimaryGroupIcons>()

  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let active = true
    setFailed(false)
    getModelPrimaryGroupIcons().then(
      result => {
        if (active) setIcons(result)
      },
      () => {
        if (active) setFailed(true)
      }
    )
    return () => {
      active = false
    }
  }, [attempt, enabled])

  return { icons, failed: enabled && failed, retry: () => setAttempt(value => value + 1) }
}
