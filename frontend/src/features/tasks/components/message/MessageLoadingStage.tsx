// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import './message-loading-stage.css'

export function MessageLoadingStage() {
  return (
    <div
      className="flex min-h-[300px] items-center justify-center py-20 text-primary"
      data-testid="messages-syncing-indicator"
    >
      <div
        className="relative flex h-28 w-56 items-center justify-center"
        data-testid="messages-syncing-animation"
      >
        <div className="absolute inset-x-3 top-7 h-3 overflow-hidden rounded-full bg-primary/10">
          <div className="h-full w-24 rounded-full bg-primary/35 animate-[message-loader-slide_1.8s_ease-in-out_infinite]" />
        </div>
        <div className="absolute inset-x-8 top-12 h-2.5 overflow-hidden rounded-full bg-text-muted/10">
          <div className="h-full w-16 rounded-full bg-text-muted/25 animate-[message-loader-slide_2.2s_ease-in-out_infinite_reverse]" />
        </div>
        <div className="absolute inset-x-14 top-[68px] h-2 overflow-hidden rounded-full bg-primary/8">
          <div className="h-full w-12 rounded-full bg-primary/25 animate-[message-loader-slide_1.6s_ease-in-out_infinite]" />
        </div>
        <div className="absolute bottom-1 flex items-center gap-2">
          <span className="h-2 w-5 rounded-full bg-primary/45 animate-[message-loader-breathe_1.2s_ease-in-out_infinite]" />
          <span className="h-2 w-5 rounded-full bg-primary/30 animate-[message-loader-breathe_1.2s_ease-in-out_infinite_160ms]" />
          <span className="h-2 w-5 rounded-full bg-primary/20 animate-[message-loader-breathe_1.2s_ease-in-out_infinite_320ms]" />
        </div>
      </div>
    </div>
  )
}
