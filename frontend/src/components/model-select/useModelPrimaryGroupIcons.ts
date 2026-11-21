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

  useEffect(() => {
    if (!enabled) return
    let active = true
    getModelPrimaryGroupIcons().then(
      result => {
        if (active) setIcons(result)
      },
      () => {
        if (active) setIcons(undefined)
      }
    )
    return () => {
      active = false
    }
  }, [enabled])

  return icons
}
