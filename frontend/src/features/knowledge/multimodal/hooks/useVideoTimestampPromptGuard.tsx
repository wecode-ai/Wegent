// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import { VideoTimestampPromptWarningDialog } from '../components/VideoTimestampPromptWarningDialog'
import {
  checkVideoTimestampPrompt,
  injectVideoTimestampContract,
  type VideoTimestampPromptStatus,
} from '../utils/videoTimestampPromptGuard'

export interface VideoTimestampPromptReviewResult {
  prompt: string | null
  injected: boolean
}

type ContinueReview = (result: VideoTimestampPromptReviewResult) => void | Promise<void>

interface PendingReview {
  prompt: string
  status: VideoTimestampPromptStatus
  continuation: ContinueReview
}

export function useVideoTimestampPromptGuard() {
  const [pending, setPending] = useState<PendingReview | null>(null)
  const injection = useMemo(
    () => (pending ? injectVideoTimestampContract(pending.prompt) : null),
    [pending]
  )

  const reviewVideoPrompt = (prompt: string | null | undefined, continuation: ContinueReview) => {
    const customPrompt = prompt?.trim()
    if (!customPrompt) {
      void continuation({ prompt: prompt ?? null, injected: false })
      return
    }
    const { status } = checkVideoTimestampPrompt(customPrompt)
    if (status === 'verified' || status === 'compliant') {
      void continuation({ prompt: customPrompt, injected: false })
      return
    }
    setPending({ prompt: customPrompt, status, continuation })
  }

  const continueReview = (result: VideoTimestampPromptReviewResult) => {
    const continuation = pending?.continuation
    setPending(null)
    if (continuation) void continuation(result)
  }

  return {
    reviewVideoPrompt,
    videoTimestampPromptWarningDialog: (
      <VideoTimestampPromptWarningDialog
        open={Boolean(pending)}
        status={pending?.status ?? 'missing'}
        injectionExceedsLimit={injection?.exceedsLimit ?? false}
        onCancel={() => setPending(null)}
        onSkip={() =>
          continueReview({
            prompt: pending?.prompt ?? null,
            injected: false,
          })
        }
        onInject={() =>
          continueReview({
            prompt: injection?.prompt ?? pending?.prompt ?? null,
            injected: true,
          })
        }
      />
    ),
  }
}
