// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Keyboard, Mic, Volume2 } from 'lucide-react'
import { apiClient } from '@/apis/client'
import {
  configureDingTalkJsapi,
  startDingTalkRecord,
  stopDingTalkRecord,
  translateDingTalkVoice,
} from '@/dingtalk/lib/dingtalk-sdk'
import type { JsapiSignData } from '@/dingtalk/lib/dingtalk-sdk'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'

interface DingTalkAudioRecordButtonProps {
  /** Callback when voice-to-text conversion is complete */
  onTextResult: (text: string) => void
  /** Whether the button is disabled */
  disabled?: boolean
  /** Callback when voice mode visibility changes */
  onVoiceModeChange?: (isVoiceMode: boolean) => void
  /** Optional className for root container */
  className?: string
}

type RecordState = 'idle' | 'recording' | 'converting'
type VoiceInputMode = 'text' | 'voice'

const MIN_RECORD_DURATION_MS = 1000
const CANCEL_THRESHOLD_PX = 70
const MAX_RECORD_SECONDS = 300
const WAVEFORM_COLLAPSED_BAR_COUNT = 24

/**
 * Fetch JSAPI signature from backend for dd.config authentication.
 */
async function fetchJsapiSign(url: string): Promise<JsapiSignData> {
  const encodedUrl = encodeURIComponent(url)
  return apiClient.get<JsapiSignData>(`/auth/dingtalk/jsapi-sign?url=${encodedUrl}`)
}

/**
 * Initialize dd.config with JSAPI signature.
 * Fetches signature from backend and configures DingTalk JSAPI.
 */
async function initDingTalkConfig(): Promise<void> {
  const url = window.location.href.split('#')[0]
  const signData = await fetchJsapiSign(url)
  await configureDingTalkJsapi(signData)
}

/**
 * DingTalk audio record button component.
 * Supports switching between text input mode and voice press-to-talk mode.
 */
export default function DingTalkAudioRecordButton({
  onTextResult,
  disabled = false,
  onVoiceModeChange,
  className,
}: DingTalkAudioRecordButtonProps) {
  const { t } = useTranslation('chat')
  const { toast } = useToast()
  const [voiceMode, setVoiceMode] = useState<VoiceInputMode>('text')
  const [jsapiReady, setJsapiReady] = useState(false)
  const [jsapiError, setJsapiError] = useState<string | null>(null)
  const recordStartTimeRef = useRef<number>(0)
  const pressStartPointRef = useRef<{ x: number; y: number } | null>(null)
  const shouldCancelRef = useRef(false)
  const isProcessingRef = useRef(false)
  const autoStopTimerRef = useRef<number | null>(null)
  const countdownTimerRef = useRef<number | null>(null)
  // Use a ref to track recordState to avoid stale closure issues in callbacks
  const recordStateRef = useRef<RecordState>('idle')
  // Ref to the record button DOM element for native event listeners
  const recordButtonRef = useRef<HTMLButtonElement | null>(null)
  // Ref to the countdown label DOM element for direct DOM updates (avoids React re-renders during recording)
  const countdownLabelRef = useRef<HTMLSpanElement | null>(null)
  // Ref to the top status label DOM element for direct DOM updates
  const topLabelRef = useRef<HTMLSpanElement | null>(null)
  // Ref to the record button inner content wrapper for direct DOM swap (idle text <-> waveform)
  const recordButtonContentRef = useRef<HTMLSpanElement | null>(null)
  const recordButtonWaveformRef = useRef<HTMLDivElement | null>(null)

  // Update recordStateRef and optionally trigger a re-render (only needed for converting state)
  const setRecordStateSync = useCallback((state: RecordState) => {
    recordStateRef.current = state
  }, [])

  useEffect(() => {
    onVoiceModeChange?.(voiceMode === 'voice')
  }, [voiceMode, onVoiceModeChange])

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      try {
        await initDingTalkConfig()
        if (!cancelled) {
          setJsapiReady(true)
          setJsapiError(null)
          console.log('[DingTalkAudio] JSAPI configured successfully')
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          setJsapiError(msg)
          console.error('[DingTalkAudio] Failed to configure JSAPI:', err)
          toast({
            variant: 'destructive',
            title: t('dingtalk_audio.config_failed', { defaultValue: '钉钉 JSAPI 初始化失败' }),
            description: msg,
          })
        }
      }
    }

    init()

    const refreshInterval = setInterval(() => {
      if (!cancelled) {
        init()
      }
    }, 3600 * 1000)

    return () => {
      cancelled = true
      clearInterval(refreshInterval)
    }
  }, [toast, t])

  const clearTimers = useCallback(() => {
    if (autoStopTimerRef.current !== null) {
      window.clearTimeout(autoStopTimerRef.current)
      autoStopTimerRef.current = null
    }
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const resetRecordingUi = useCallback(() => {
    shouldCancelRef.current = false
    pressStartPointRef.current = null
    clearTimers()

    // Reset DOM state back to idle appearance
    if (recordButtonRef.current) {
      recordButtonRef.current.style.backgroundColor = ''
      recordButtonRef.current.style.color = ''
      recordButtonRef.current.style.transform = ''
    }
    if (recordButtonContentRef.current) {
      recordButtonContentRef.current.style.display = ''
    }
    if (recordButtonWaveformRef.current) {
      recordButtonWaveformRef.current.style.display = 'none'
    }
    if (topLabelRef.current) {
      topLabelRef.current.style.display = 'none'
      topLabelRef.current.textContent = ''
    }
    if (countdownLabelRef.current) {
      countdownLabelRef.current.style.display = 'none'
      countdownLabelRef.current.textContent = ''
    }
  }, [clearTimers])

  // Update cancel/recording UI state directly via DOM to avoid React re-renders during recording.
  // React re-renders during an active touch sequence break touch tracking in DingTalk WebView.
  const updateCancelStateByPoint = useCallback((clientY: number) => {
    const startPoint = pressStartPointRef.current
    if (!startPoint) return

    const isCancel = startPoint.y - clientY > CANCEL_THRESHOLD_PX
    const wasCancel = shouldCancelRef.current
    shouldCancelRef.current = isCancel

    // Only update DOM if state actually changed to minimize DOM mutations
    if (isCancel !== wasCancel) {
      const btn = recordButtonRef.current
      if (btn) {
        // Use inline style to avoid Tailwind class name escaping issues
        btn.style.backgroundColor = isCancel ? 'rgb(239 68 68)' : '#1677FF'
      }
      if (topLabelRef.current) {
        topLabelRef.current.textContent = isCancel
          ? (topLabelRef.current.dataset.cancelText ?? '')
          : (topLabelRef.current.dataset.recordingText ?? '')
        topLabelRef.current.style.color = isCancel ? 'rgb(239 68 68)' : '#1677FF'
      }
      if (countdownLabelRef.current) {
        countdownLabelRef.current.style.display = isCancel ? 'none' : ''
      }
    }
  }, [])

  const extractClientPoint = (
    e: React.TouchEvent | React.MouseEvent,
    useChangedTouches = false
  ): { x: number; y: number } | null => {
    if ('touches' in e) {
      const touch = useChangedTouches ? e.changedTouches[0] : e.touches[0]
      if (!touch) return null
      return { x: touch.clientX, y: touch.clientY }
    }

    return { x: e.clientX, y: e.clientY }
  }
  const finishRecording = useCallback(
    async (cancelledByGesture: boolean) => {
      console.log(
        '[finishRecording] called, cancelledByGesture:',
        cancelledByGesture,
        '| recordStateRef.current:',
        recordStateRef.current,
        '| isProcessingRef.current:',
        isProcessingRef.current
      )

      // Use ref to read the latest recordState, avoiding stale closure issues
      if (recordStateRef.current !== 'recording' || !isProcessingRef.current) {
        console.log(
          '[finishRecording] early return - guard check failed. recordStateRef.current:',
          recordStateRef.current,
          'isProcessingRef.current:',
          isProcessingRef.current
        )
        return
      }

      isProcessingRef.current = false
      clearTimers()
      const duration = Date.now() - recordStartTimeRef.current
      console.log(
        '[finishRecording] recording duration ms:',
        duration,
        '| MIN_RECORD_DURATION_MS:',
        MIN_RECORD_DURATION_MS
      )

      if (cancelledByGesture || duration < MIN_RECORD_DURATION_MS) {
        console.log(
          '[finishRecording] stopping without convert - cancelledByGesture:',
          cancelledByGesture,
          'duration too short:',
          duration < MIN_RECORD_DURATION_MS
        )
        try {
          await stopDingTalkRecord()
          console.log('[finishRecording] stopDingTalkRecord (cancel/short) succeeded')
        } catch (err) {
          console.error('[finishRecording] stopRecord (cancelled/short) failed:', err)
        } finally {
          setRecordStateSync('idle')
          resetRecordingUi()
        }
        return
      }

      console.log('[finishRecording] proceeding to convert voice to text')
      setRecordStateSync('converting')
      // Show converting state via DOM: keep waveform visible, update top label
      if (topLabelRef.current) {
        topLabelRef.current.style.display = ''
        topLabelRef.current.textContent = t('dingtalk_audio.converting_to_text', {
          defaultValue: '正在转文字...',
        })
        topLabelRef.current.style.color = '#1677FF'
      }
      if (countdownLabelRef.current) {
        countdownLabelRef.current.textContent = t('dingtalk_audio.processing_wait', {
          defaultValue: '正在识别语音，请稍候',
        })
        countdownLabelRef.current.style.display = ''
      }

      try {
        console.log('[finishRecording] calling stopDingTalkRecord...')
        const recordResult = await stopDingTalkRecord()
        console.log(
          '[finishRecording] stopDingTalkRecord succeeded, mediaId:',
          recordResult.mediaId,
          'duration:',
          recordResult.duration
        )
        try {
          console.log('[finishRecording] calling translateDingTalkVoice...')
          const text = await translateDingTalkVoice(recordResult.mediaId, recordResult.duration)
          console.log('[finishRecording] translateDingTalkVoice succeeded, text:', text)
          if (text) {
            onTextResult(text)
          }
        } catch (translateErr) {
          const msg = translateErr instanceof Error ? translateErr.message : String(translateErr)
          console.error('[finishRecording] translateVoice failed:', translateErr)
          toast({
            variant: 'destructive',
            title: t('dingtalk_audio.translate_failed', { defaultValue: '语音转文字失败' }),
            description: msg,
          })
        }
      } catch (stopErr) {
        const msg = stopErr instanceof Error ? stopErr.message : String(stopErr)
        console.error('[finishRecording] stopRecord failed:', stopErr)
        toast({
          variant: 'destructive',
          title: t('dingtalk_audio.stop_failed', { defaultValue: '停止录音失败' }),
          description: msg,
        })
      } finally {
        console.log('[finishRecording] finally: resetting state to idle')
        setRecordStateSync('idle')
        setVoiceMode('voice')
        resetRecordingUi()
      }
    },
    [clearTimers, onTextResult, resetRecordingUi, setRecordStateSync, t, toast]
  )

  // Stable ref holding the latest finishRecording and updateCancelStateByPoint to avoid
  // re-registering document listeners on every render.
  const finishRecordingRef = useRef(finishRecording)
  const updateCancelStateByPointRef = useRef(updateCancelStateByPoint)
  useEffect(() => {
    finishRecordingRef.current = finishRecording
  }, [finishRecording])
  useEffect(() => {
    updateCancelStateByPointRef.current = updateCancelStateByPoint
  }, [updateCancelStateByPoint])

  // Register native document-level listeners so touchend/mouseup are never lost during re-renders
  // in DingTalk WebView where React synthetic events can be dropped after re-renders.
  useEffect(() => {
    const handler = (e: TouchEvent | MouseEvent) => {
      // Only handle if we are actively recording
      if (recordStateRef.current !== 'recording' || !isProcessingRef.current) return

      console.log(
        '[finishRecording] handlePressEnd triggered, event type:',
        e.type,
        '| shouldCancelRef.current:',
        shouldCancelRef.current,
        '| recordStateRef.current:',
        recordStateRef.current
      )

      if (e instanceof TouchEvent) {
        const touch = e.changedTouches[0]
        if (touch) {
          updateCancelStateByPointRef.current(touch.clientY)
        }
      } else {
        updateCancelStateByPointRef.current(e.clientY)
      }

      console.log(
        '[finishRecording] handlePressEnd after updateCancelStateByPoint, shouldCancelRef.current:',
        shouldCancelRef.current
      )
      void finishRecordingRef.current(shouldCancelRef.current)
    }

    document.addEventListener('touchend', handler, { passive: false })
    document.addEventListener('touchcancel', handler, { passive: false })
    document.addEventListener('mouseup', handler)
    return () => {
      document.removeEventListener('touchend', handler)
      document.removeEventListener('touchcancel', handler)
      document.removeEventListener('mouseup', handler)
    }
  }, []) // Empty deps - handler uses refs so it never needs to be re-registered

  const handlePressStart = useCallback(
    async (e: React.TouchEvent | React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (disabled || !jsapiReady || isProcessingRef.current) return
      // Use ref to read the latest recordState, avoiding stale closure issues
      if (recordStateRef.current !== 'idle') return

      const point = extractClientPoint(e)
      if (!point) return

      isProcessingRef.current = true
      recordStartTimeRef.current = Date.now()
      pressStartPointRef.current = point
      shouldCancelRef.current = false

      // Show a "preparing" state on the button immediately (no waveform yet) to give user feedback.
      // The waveform animation is only shown AFTER startDingTalkRecord succeeds to avoid the user
      // speaking before recording has actually started.
      recordStateRef.current = 'recording'
      if (recordButtonRef.current) {
        recordButtonRef.current.style.backgroundColor = '#1677FF'
        recordButtonRef.current.style.color = 'white'
        recordButtonRef.current.style.transform = 'scale(0.98)'
      }

      try {
        await startDingTalkRecord(MAX_RECORD_SECONDS)

        // Recording has started successfully - now show the waveform animation and labels.
        // Doing this after the await ensures the user only sees the waveform when recording is live.
        if (recordButtonContentRef.current) {
          recordButtonContentRef.current.style.display = 'none'
        }
        if (recordButtonWaveformRef.current) {
          recordButtonWaveformRef.current.style.display = 'flex'
        }
        if (topLabelRef.current) {
          topLabelRef.current.style.display = ''
          topLabelRef.current.textContent = topLabelRef.current.dataset.recordingText ?? ''
          topLabelRef.current.style.color = '#1677FF'
        }
        if (countdownLabelRef.current) {
          countdownLabelRef.current.style.display = ''
          const template = countdownLabelRef.current.dataset.template ?? '{{seconds}} 秒后自动结束'
          countdownLabelRef.current.textContent = template.replace(
            '{{seconds}}',
            String(MAX_RECORD_SECONDS)
          )
        }

        autoStopTimerRef.current = window.setTimeout(() => {
          void finishRecording(false)
        }, MAX_RECORD_SECONDS * 1000)

        // Update countdown label directly via DOM to avoid React re-renders during recording.
        // Any React re-render during an active touch sequence breaks touch tracking in DingTalk WebView.
        countdownTimerRef.current = window.setInterval(() => {
          const elapsedSeconds = Math.floor((Date.now() - recordStartTimeRef.current) / 1000)
          const remaining = Math.max(MAX_RECORD_SECONDS - elapsedSeconds, 0)
          if (countdownLabelRef.current) {
            const template =
              countdownLabelRef.current.dataset.template ?? '{{seconds}} 秒后自动结束'
            countdownLabelRef.current.textContent = template.replace(
              '{{seconds}}',
              String(remaining)
            )
          }
        }, 1000)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[DingTalkAudio] startRecord failed:', err)
        toast({
          variant: 'destructive',
          title: t('dingtalk_audio.record_failed', { defaultValue: '开始录音失败' }),
          description: msg,
        })
        setRecordStateSync('idle')
        isProcessingRef.current = false
        resetRecordingUi()
      }
    },
    [disabled, finishRecording, jsapiReady, resetRecordingUi, setRecordStateSync, t, toast]
  )

  const handlePressMove = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      // Use ref to read the latest recordState, avoiding stale closure issues
      if (recordStateRef.current !== 'recording') return
      const point = extractClientPoint(e)
      if (!point) return
      updateCancelStateByPoint(point.y)
    },
    [updateCancelStateByPoint]
  )

  const handleModeToggle = useCallback(() => {
    if (disabled || recordStateRef.current !== 'idle') return
    setVoiceMode(current => (current === 'text' ? 'voice' : 'text'))
  }, [disabled])

  const isButtonDisabled = disabled || !jsapiReady
  const isVoiceMode = voiceMode === 'voice'
  const releaseToCancel = t('dingtalk_audio.release_to_cancel', { defaultValue: '松开取消' })
  const releaseToEdit = t('dingtalk_audio.release_to_edit', { defaultValue: '松手编辑, 上移取消' })

  return (
    <>
      <style>{`
        @keyframes dtalk-eq {
          0%, 100% { transform: scaleY(0.45); opacity: 0.7; }
          50% { transform: scaleY(1); opacity: 1; }
        }
      `}</style>

      <div
        className={['relative flex w-full items-center gap-2 overflow-visible py-2', className]
          .filter(Boolean)
          .join(' ')}
        data-testid="dingtalk-audio-controls"
      >
        <button
          type="button"
          disabled={disabled}
          onClick={handleModeToggle}
          className={[
            'flex h-10 w-10 min-w-[40px] items-center justify-center rounded-full border-2 bg-white transition-all select-none',
            disabled
              ? 'border-border text-text-muted cursor-not-allowed opacity-50'
              : 'border-black text-black cursor-pointer hover:bg-gray-50 active:scale-95',
          ].join(' ')}
          title={
            isVoiceMode
              ? t('dingtalk_audio.switch_to_text', { defaultValue: '切换到文字输入' })
              : t('dingtalk_audio.switch_to_voice', { defaultValue: '切换到语音输入' })
          }
          aria-label={
            isVoiceMode
              ? t('dingtalk_audio.switch_to_text', { defaultValue: '切换到文字输入' })
              : t('dingtalk_audio.switch_to_voice', { defaultValue: '切换到语音输入' })
          }
          data-testid="dingtalk-audio-mode-toggle-button"
        >
          {isVoiceMode ? (
            <Keyboard className="h-4 w-4" strokeWidth={2.3} />
          ) : (
            <Volume2 className="h-4 w-4" strokeWidth={2.3} />
          )}
        </button>

        {isVoiceMode && (
          <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
            {/*
              Top label: always rendered but hidden by default.
              Direct DOM manipulation shows/hides and updates text during recording
              to avoid React re-renders that break touch tracking in DingTalk WebView.
            */}
            <span
              ref={topLabelRef}
              className="pointer-events-none text-[11px] font-medium leading-none text-[#1677FF]"
              style={{ userSelect: 'none', WebkitUserSelect: 'none', display: 'none' }}
              data-cancel-text={releaseToCancel}
              data-recording-text={releaseToEdit}
            />
            <button
              ref={recordButtonRef}
              type="button"
              disabled={isButtonDisabled}
              onTouchStart={handlePressStart}
              onTouchMove={handlePressMove}
              onMouseDown={handlePressStart}
              onMouseMove={handlePressMove}
              className={[
                'relative flex h-14 w-full min-w-0 touch-none items-center justify-center rounded-full px-3 transition-all select-none overflow-hidden',
                isButtonDisabled
                  ? 'bg-surface text-text-muted cursor-not-allowed opacity-50'
                  : 'bg-surface text-text-primary active:scale-[0.98]',
              ].join(' ')}
              title={
                jsapiError
                  ? `JSAPI error: ${jsapiError}`
                  : t('dingtalk_audio.hold_to_speak', { defaultValue: '按住说话' })
              }
              aria-label={t('dingtalk_audio.hold_to_speak', { defaultValue: '按住说话' })}
              data-testid="dingtalk-audio-record-button"
            >
              {/* Idle content: shown by default, hidden during recording via DOM */}
              <span ref={recordButtonContentRef} className="flex items-center gap-2">
                <Mic className="h-5 w-5 text-text-secondary" />
                <span>{t('dingtalk_audio.hold_to_speak', { defaultValue: '按住说话' })}</span>
              </span>
              {/* Waveform: hidden by default, shown during recording via DOM */}
              <div
                ref={recordButtonWaveformRef}
                className="flex h-11 w-full items-center justify-center gap-1 overflow-hidden px-3"
                style={{ display: 'none' }}
                aria-hidden="true"
              >
                {Array.from({ length: WAVEFORM_COLLAPSED_BAR_COUNT }, (_, index) => {
                  const phase = (3 + index * 17) % 100
                  const base = 16 + (phase % 6) * 4
                  const accent = index % 6 === 0 ? 14 : index % 5 === 0 ? 8 : 0
                  const height = Math.min(Math.min(base + accent, 48), 24)
                  return (
                    <span
                      key={index}
                      className="w-1 shrink-0 rounded-full bg-white/95"
                      style={{
                        height: `${height}px`,
                        animation: `dtalk-eq 1s ease-in-out ${index * 0.04}s infinite`,
                      }}
                    />
                  )
                })}
              </div>
            </button>
            {/*
              Bottom countdown label: always rendered but hidden by default.
              Direct DOM manipulation updates text and visibility during recording.
            */}
            <span
              ref={countdownLabelRef}
              className="pointer-events-none text-[10px] leading-none text-text-secondary whitespace-nowrap"
              style={{ userSelect: 'none', WebkitUserSelect: 'none', display: 'none' }}
              data-template={t('dingtalk_audio.recording_countdown', {
                defaultValue: '{{seconds}} 秒后自动结束',
                seconds: '{{seconds}}',
              })}
            />
          </div>
        )}
      </div>
    </>
  )
}
