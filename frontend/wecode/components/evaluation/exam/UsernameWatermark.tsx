// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'

interface UsernameWatermarkProps {
  username: string
  opacity?: number
  fontSize?: number
  rotation?: number
  density?: 'low' | 'medium' | 'high'
}

export function UsernameWatermark({
  username,
  opacity = 0.06,
  fontSize = 14,
  rotation = -30,
  density = 'medium',
}: UsernameWatermarkProps) {
  const watermarkItems = useMemo(() => {
    const items = []
    const rows = density === 'low' ? 3 : density === 'medium' ? 5 : 7
    const cols = density === 'low' ? 3 : density === 'medium' ? 4 : 6

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        items.push({
          id: `${row}-${col}`,
          top: `${(row + 0.5) * (100 / rows)}%`,
          left: `${(col + 0.5) * (100 / cols)}%`,
        })
      }
    }
    return items
  }, [density])

  if (!username) return null

  return (
    <div
      className="fixed inset-0 pointer-events-none z-[9999] overflow-hidden"
      style={{ opacity }}
      aria-hidden="true"
    >
      {watermarkItems.map(item => (
        <div
          key={item.id}
          className="absolute whitespace-nowrap select-none text-gray-900 font-medium"
          style={{
            top: item.top,
            left: item.left,
            fontSize: `${fontSize}px`,
            transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          }}
        >
          {username}
        </div>
      ))}
    </div>
  )
}
