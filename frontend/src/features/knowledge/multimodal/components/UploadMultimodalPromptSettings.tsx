// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { isVideoFileName, isImageExtension } from '@/apis/attachments'
import { MultimodalPromptEditor } from './MultimodalPromptEditor'

/**
 * A queue file as seen by the upload dialog: an optional renamed attachment
 * filename plus the original File. Only `filename`/`name` are used here for
 * media-type detection.
 */
export interface UploadQueueFile {
  attachment?: { filename?: string } | null
  file: { name: string }
}

/** Per-media-type prompt overrides produced by this settings block. */
export interface UploadMultimodalPrompts {
  video?: string | null
  image?: string | null
}

interface UploadMultimodalPromptSettingsProps {
  /** Files currently in the upload queue (used to detect which media types are present). */
  files: UploadQueueFile[]
  /** Whether multimodal analysis is enabled for the KB (gates the whole block). */
  multimodalAnalysisEnabled: boolean
  /** KB-level video prompt (resolves the inherited effective value shown to the user). */
  kbVideoPrompt?: string | null
  /** KB-level image prompt (resolves the inherited effective value shown to the user). */
  kbImagePrompt?: string | null
  /**
   * Called whenever the user edits a prompt (and on mount/reset). Receives the
   * current `{ video, image }` overrides, or `null` when the queue has no
   * multimodal files. The parent reads this at submit time to forward the
   * correct per-type override to each created document.
   */
  onChange: (prompts: UploadMultimodalPrompts | null) => void
}

/**
 * Advanced-settings block for multimodal (video/image) upload prompt overrides.
 *
 * Rendered inside the upload dialog's advanced accordion. Detects which media
 * types are present in the queue and shows one prompt editor per type, so a
 * mixed video+image batch can carry separate prompts. Extracted from
 * `DocumentUpload.tsx` to keep that shared file free of a large multimodal
 * block (this file is private to the multimodal pipeline and stripped from the
 * open-source build as a whole file, avoiding line-level stripping conflicts).
 */
export function UploadMultimodalPromptSettings({
  files,
  multimodalAnalysisEnabled,
  kbVideoPrompt,
  kbImagePrompt,
  onChange,
}: UploadMultimodalPromptSettingsProps) {
  const { t } = useTranslation('knowledge')
  const [videoPrompt, setVideoPrompt] = useState<string | null>(null)
  const [imagePrompt, setImagePrompt] = useState<string | null>(null)

  // Detect which multimodal media types the queue contains.
  const { hasVideo, hasImage, isMultimodal } = useMemo(() => {
    let v = false
    let i = false
    for (const f of files) {
      const name = f.attachment?.filename || f.file.name
      if (isVideoFileName(name)) v = true
      else if (isImageExtension(name.slice(name.lastIndexOf('.')))) i = true
    }
    return { hasVideo: v, hasImage: i, isMultimodal: v || i }
  }, [files])

  // Report the current overrides up whenever they (or the queue's media types) change.
  useEffect(() => {
    if (!multimodalAnalysisEnabled || !isMultimodal) {
      onChange(null)
      return
    }
    onChange({
      video: hasVideo ? videoPrompt : undefined,
      image: hasImage ? imagePrompt : undefined,
    })
  }, [
    multimodalAnalysisEnabled,
    isMultimodal,
    hasVideo,
    hasImage,
    videoPrompt,
    imagePrompt,
    onChange,
  ])

  if (!multimodalAnalysisEnabled || !isMultimodal) {
    return null
  }

  return (
    <>
      {hasVideo && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-text-primary">
            {t('document.multimodal.videoPromptLabel')}
          </p>
          <MultimodalPromptEditor
            mediaType="video"
            scope="document"
            value={videoPrompt}
            onChange={setVideoPrompt}
            kbPrompt={kbVideoPrompt}
            idSuffix="upload-video"
          />
        </div>
      )}
      {hasImage && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-text-primary">
            {t('document.multimodal.imagePromptLabel')}
          </p>
          <MultimodalPromptEditor
            mediaType="image"
            scope="document"
            value={imagePrompt}
            onChange={setImagePrompt}
            kbPrompt={kbImagePrompt}
            idSuffix="upload-image"
          />
        </div>
      )}
    </>
  )
}
