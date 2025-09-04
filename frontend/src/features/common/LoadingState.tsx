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
  message = "Loading..." 
}: LoadingStateProps) {
  if (fullScreen) {
    return (
      <div className="flex h-screen bg-[#0d1117] items-center justify-center">
        <div className="text-white">{message}</div>
      </div>
    )
  }
  
  return (
    <div className="flex items-center justify-center p-4">
      <div className="text-white">{message}</div>
    </div>
  )
}