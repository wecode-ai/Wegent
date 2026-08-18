// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface EntityExt {
  visual_description?: string | null
}

export interface EntityItem {
  id: number
  entity_id: string
  entity_name: string
  entity_type: number
  description: string | null
  image_pid: string
  image_url: string
  generation_status: number
  task_uuid?: string | null
  dynamic_features?: string | null
  ext?: EntityExt | null
}

export interface EntityListResponse {
  characters: EntityItem[]
  scenes: EntityItem[]
  props: EntityItem[]
  ratio?: string
  title?: string | null
}
