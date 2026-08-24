// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ComponentType } from 'react'
import type { CardRendererProps } from './types'
import { VideoDirectorGenerationCard } from './VideoDirectorGenerationCard'

const cardRegistry: Record<string, ComponentType<CardRendererProps>> = {
  video_director_generation: VideoDirectorGenerationCard,
}

export function getCardComponent(cardType: string): ComponentType<CardRendererProps> | null {
  return cardRegistry[cardType] ?? null
}

export function registerCardComponent(
  cardType: string,
  component: ComponentType<CardRendererProps>
): void {
  cardRegistry[cardType] = component
}
