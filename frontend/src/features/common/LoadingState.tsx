// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

type LoadingStateProps = {
  fullScreen?: boolean
  message?: string
}

export default function LoadingState({ fullScreen = true, message }: LoadingStateProps) {
  if (fullScreen) {
    return (
      <div className="flex smart-h-screen bg-base items-center justify-center box-border">
        <div className="text-text-primary">{message}</div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center p-4">
      <div className="text-text-primary">{message}</div>
    </div>
  )
}
