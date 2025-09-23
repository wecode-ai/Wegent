// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

type LoadingStateProps = {
  fullScreen?: boolean
  message?: string
}

export default function LoadingState({
  fullScreen = true,
  message
}: LoadingStateProps) {
  if (fullScreen) {
    return (
      <div className="flex h-screen bg-theme-app text-theme-primary transition-colors items-center justify-center">
        <div>{message}</div>
      </div>
    )
  }
  
  return (
    <div className="flex items-center justify-center p-4 text-theme-primary transition-colors">
      <div>{message}</div>
    </div>
  )
}
