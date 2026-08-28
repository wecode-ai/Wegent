// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export { CompositionEditor } from './CompositionEditor'
export { compositionApis } from './api'
export { parseSrt, buildSubtitlesFromSrt } from './utils'
export type { InspectorTab } from './ClipInspector'
export type {
  CompositionClip,
  CompositionSubtitle,
  CompositionMusic,
  VideoCompositionDraft,
  VideoCompositionRender,
  SaveCompositionRequest,
  SaveCompositionResponse,
} from './types'
