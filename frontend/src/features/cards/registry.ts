// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AsyncCardComponent } from './types'

const cardRegistry: Record<string, () => Promise<{ default: AsyncCardComponent }>> = {
  video_director_generation: () => import('@/features/video/aigc_video/AigcVideoCard'),
  video_short_generation: () => import('@/features/video/aigc_video/AigcVideoCard'),
}

export async function loadAsyncCardComponent(cardType: string): Promise<AsyncCardComponent | null> {
  const loader = cardRegistry[cardType]
  if (!loader) return null
  return (await loader()).default
}
