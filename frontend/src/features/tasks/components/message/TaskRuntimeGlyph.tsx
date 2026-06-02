// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import type { TaskStateData } from '@/features/tasks/state'

const GLYPH_VISIBLE_DELAY_MS = 3000

const TASK_MACHINE_STATUS_CODES = {
  idle: 0,
  waiting_socket: 1,
  joining: 2,
  syncing: 3,
  ready: 4,
  streaming: 5,
  error: 6,
} as const

const TASK_RUNTIME_PHASE_CODES = {
  unknown: 0,
  syncing: 1,
  running: 2,
  streaming: 3,
  waiting_for_user: 4,
  terminal: 5,
  error: 6,
} as const

const STATUS_SYMBOLS = ['🌑', '📡', '🔌', '🔄', '✅', '🌊', '⚠️']
const PHASE_SYMBOLS = ['❔', '🌫️', '🟢', '✨', '⏳', '🏁', '🧯']
const ROOM_SYMBOLS = ['🚪', '🏠']
const RECOVERY_SYMBOLS = ['🪶', '🧭']
const ERROR_SYMBOLS = ['⚪', '🔴']
const STREAM_SYMBOLS = ['▫️', '💧']

type RuntimeGlyphState = {
  taskId: number
  code: string
  symbols: string[]
}

interface TaskRuntimeGlyphProps {
  taskState: TaskStateData | null
  visible: boolean
}

function buildRuntimeGlyphState(taskState: TaskStateData): RuntimeGlyphState {
  const statusCode = TASK_MACHINE_STATUS_CODES[taskState.status] ?? 0
  const phaseCode = TASK_RUNTIME_PHASE_CODES[taskState.runtime.phase] ?? 0
  const roomCode = taskState.runtime.joinedRoom ? 1 : 0
  const reasonCode = taskState.runtime.recoveryReason ? 1 : 0
  const errorCode = taskState.runtime.recoveryError || taskState.error ? 1 : 0
  const streamCode = taskState.runtime.activeStreamSubtaskId ? 1 : 0

  return {
    taskId: taskState.taskId,
    code: `s${statusCode}-p${phaseCode}-r${roomCode}-q${reasonCode}-e${errorCode}-m${streamCode}`,
    symbols: [
      STATUS_SYMBOLS[statusCode],
      PHASE_SYMBOLS[phaseCode],
      ROOM_SYMBOLS[roomCode],
      RECOVERY_SYMBOLS[reasonCode],
      ERROR_SYMBOLS[errorCode],
      STREAM_SYMBOLS[streamCode],
    ],
  }
}

export function TaskRuntimeGlyph({ taskState, visible }: TaskRuntimeGlyphProps) {
  const glyph = useMemo(() => {
    if (!taskState) return null
    return buildRuntimeGlyphState(taskState)
  }, [taskState])
  const glyphKey = visible && glyph ? `${glyph.taskId}:${glyph.code}` : null
  const [visibleGlyphKey, setVisibleGlyphKey] = useState<string | null>(null)

  useEffect(() => {
    setVisibleGlyphKey(null)

    if (!glyphKey) {
      return
    }

    const timer = window.setTimeout(() => {
      setVisibleGlyphKey(glyphKey)
    }, GLYPH_VISIBLE_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [glyphKey])

  if (!glyph || !glyphKey || visibleGlyphKey !== glyphKey) return null

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-14 z-0 flex justify-center"
      data-runtime-code={glyph.code}
      data-task-id={glyph.taskId}
      data-testid="task-runtime-watermark"
    >
      <div className="relative h-[170px] w-[360px] select-none" data-testid="task-runtime-glyph">
        <svg
          className="absolute inset-0 h-full w-full opacity-45"
          fill="none"
          viewBox="0 0 360 170"
        >
          <path
            d="M42 89 C88 35 136 35 180 89 C224 143 272 143 318 89"
            opacity="0.26"
            stroke="rgb(var(--color-primary))"
            strokeLinecap="round"
            strokeWidth="14"
          />
          <path
            d="M56 116 C105 145 140 145 180 116 C220 87 255 87 304 116"
            opacity="0.2"
            stroke="rgb(var(--color-text-muted))"
            strokeDasharray="38 22"
            strokeLinecap="round"
            strokeWidth="9"
          />
          <path
            d="M82 66 H132 C151 66 162 86 180 86 C198 86 209 66 228 66 H278"
            opacity="0.18"
            stroke="rgb(var(--color-primary))"
            strokeDasharray="68 18"
            strokeLinecap="round"
            strokeWidth="7"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-3 rounded-full bg-base/55 px-6 py-3 text-2xl shadow-sm ring-1 ring-border/25 backdrop-blur-[2px]">
            {glyph.symbols.map((symbol, index) => (
              <span
                className="leading-none opacity-80"
                data-runtime-symbol=""
                key={`${symbol}-${index}`}
              >
                {symbol}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
