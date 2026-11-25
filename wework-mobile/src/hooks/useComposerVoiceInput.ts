import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'

export type ComposerVoiceState = 'idle' | 'starting' | 'recording' | 'transcribing' | 'error'

interface ComposerVoiceInputOptions {
  onTranscript: (text: string, send: boolean) => void
}

export interface ComposerVoiceInput {
  cancel: () => void
  errorMessage: string
  levels: number[]
  requestSend: () => void
  retry: () => Promise<void>
  start: () => Promise<void>
  state: ComposerVoiceState
  stop: (send?: boolean) => void
}

const voiceLanguage = 'zh-CN'
const waveformBars = 36
const quietLevels = () => Array.from({ length: waveformBars }, () => 0)

function androidOfflineMessage(): string {
  return Number(Platform.Version) < 31
    ? '当前 Android 版本不支持本地语音识别'
    : '请先下载中文离线语音包'
}

function errorMessageFor(code: string): string {
  switch (code) {
    case 'not-allowed':
      return '请在系统设置中允许 WeWork 使用麦克风和语音识别'
    case 'no-speech':
    case 'speech-timeout':
      return '没有识别到语音'
    case 'language-not-supported':
      return Platform.OS === 'android' ? androidOfflineMessage() : '当前设备不支持中文离线语音识别'
    case 'service-not-allowed':
      return '当前设备没有可用的本地语音识别服务'
    case 'audio-capture':
      return '无法使用麦克风'
    case 'network':
      return '本地语音识别不可用'
    default:
      return '转文字出错'
  }
}

async function ensureAndroidLocaleInstalled(): Promise<void> {
  if (Platform.OS !== 'android') return
  try {
    const support = await ExpoSpeechRecognitionModule.getSupportedLocales({
      androidRecognitionServicePackage: 'com.google.android.as',
    })
    if (!support.locales.length) return
    if (support.installedLocales.includes(voiceLanguage)) return
    await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({
      locale: voiceLanguage,
    })
    throw new Error('请先在系统弹窗中下载中文离线语音包')
  } catch (error) {
    if (error instanceof Error && error.message.includes('离线语音包')) throw error
    // Older Android versions cannot enumerate locales. Starting the recognizer
    // still gives the platform a chance to report a precise language error.
  }
}

export function useComposerVoiceInput({
  onTranscript,
}: ComposerVoiceInputOptions): ComposerVoiceInput {
  const [state, setState] = useState<ComposerVoiceState>('idle')
  const [levels, setLevels] = useState<number[]>(quietLevels)
  const [errorMessage, setErrorMessage] = useState('')
  const stateRef = useRef<ComposerVoiceState>('idle')
  const committedTranscriptRef = useRef('')
  const deliveredRef = useRef(false)
  const sendAfterTranscriptRef = useRef(false)
  const startTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  const updateState = useCallback((next: ComposerVoiceState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const deliverTranscript = useCallback(() => {
    if (deliveredRef.current) return
    deliveredRef.current = true
    const transcript = committedTranscriptRef.current.trim()
    committedTranscriptRef.current = ''
    const send = sendAfterTranscriptRef.current
    sendAfterTranscriptRef.current = false
    if (!transcript) {
      setErrorMessage('没有识别到语音')
      updateState('error')
      return
    }
    onTranscriptRef.current(transcript, send)
    updateState('idle')
  }, [updateState])

  const clearStartTimeout = useCallback(() => {
    if (startTimeoutRef.current === null) return
    clearTimeout(startTimeoutRef.current)
    startTimeoutRef.current = null
  }, [])

  useEffect(() => () => clearStartTimeout(), [clearStartTimeout])

  useEffect(
    () => () => {
      attemptRef.current += 1
      if (stateRef.current !== 'idle') ExpoSpeechRecognitionModule.abort()
    },
    []
  )

  const start = useCallback(async () => {
    if (stateRef.current === 'starting' || stateRef.current === 'recording') return
    const attempt = ++attemptRef.current
    committedTranscriptRef.current = ''
    deliveredRef.current = false
    sendAfterTranscriptRef.current = false
    setErrorMessage('')
    setLevels(quietLevels())
    updateState('starting')
    clearStartTimeout()

    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (attemptRef.current !== attempt) return
      if (!permission.granted) {
        throw new Error('请在系统设置中允许 WeWork 使用麦克风和语音识别')
      }
      if (Platform.OS === 'android' && Number(Platform.Version) < 33) {
        throw new Error('本地语音输入需要 Android 13 或更高版本')
      }
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        throw new Error('当前设备没有可用的本地语音识别服务')
      }
      if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) {
        throw new Error(
          Platform.OS === 'android' ? androidOfflineMessage() : '当前设备不支持中文离线语音识别'
        )
      }
      await ensureAndroidLocaleInstalled()
      if (attemptRef.current !== attempt) return
      startTimeoutRef.current = setTimeout(() => {
        if (stateRef.current !== 'starting') return
        setErrorMessage('无法启动本地语音识别')
        updateState('error')
        ExpoSpeechRecognitionModule.abort()
      }, 15000)
      ExpoSpeechRecognitionModule.start({
        addsPunctuation: true,
        continuous: true,
        interimResults: true,
        iosTaskHint: 'dictation',
        lang: voiceLanguage,
        requiresOnDeviceRecognition: true,
        volumeChangeEventOptions: { enabled: true, intervalMillis: 120 },
      })
    } catch (error) {
      if (attemptRef.current !== attempt) return
      clearStartTimeout()
      setErrorMessage(error instanceof Error ? error.message : '转文字出错')
      updateState('error')
    }
  }, [clearStartTimeout, updateState])

  const stop = useCallback(
    (send = false) => {
      if (stateRef.current === 'starting' || stateRef.current === 'recording') {
        sendAfterTranscriptRef.current = send
        updateState('transcribing')
        ExpoSpeechRecognitionModule.stop()
        return
      }
      if (stateRef.current === 'transcribing' && send) {
        sendAfterTranscriptRef.current = true
      }
    },
    [updateState]
  )

  const cancel = useCallback(() => {
    attemptRef.current += 1
    clearStartTimeout()
    deliveredRef.current = true
    committedTranscriptRef.current = ''
    sendAfterTranscriptRef.current = false
    ExpoSpeechRecognitionModule.abort()
    setLevels(quietLevels())
    setErrorMessage('')
    updateState('idle')
  }, [clearStartTimeout, updateState])

  const retry = useCallback(async () => {
    await start()
  }, [start])

  useSpeechRecognitionEvent('start', () => {
    clearStartTimeout()
    updateState('recording')
  })

  useSpeechRecognitionEvent('volumechange', event => {
    if (stateRef.current !== 'starting' && stateRef.current !== 'recording') return
    const normalized = Math.max(0, Math.min(1, (event.value + 2) / 12))
    setLevels(current => [...current.slice(1), normalized])
  })

  useSpeechRecognitionEvent('result', event => {
    const transcript = event.results[0]?.transcript ?? ''
    if (!event.isFinal || !transcript.trim()) return
    const existing = committedTranscriptRef.current.trim()
    committedTranscriptRef.current = existing
      ? `${existing} ${transcript.trim()}`
      : transcript.trim()
  })

  useSpeechRecognitionEvent('nomatch', () => {
    clearStartTimeout()
    if (stateRef.current === 'recording') return
    if (stateRef.current === 'transcribing') deliverTranscript()
  })

  useSpeechRecognitionEvent('error', event => {
    clearStartTimeout()
    if (event.error === 'aborted') {
      if (
        stateRef.current === 'starting' ||
        stateRef.current === 'recording' ||
        stateRef.current === 'transcribing'
      ) {
        updateState('idle')
      }
      return
    }
    if (committedTranscriptRef.current.trim()) {
      deliverTranscript()
      return
    }
    if (
      stateRef.current === 'recording' &&
      (event.error === 'no-speech' || event.error === 'speech-timeout')
    ) {
      return
    }
    setErrorMessage(errorMessageFor(event.error))
    updateState('error')
  })

  useSpeechRecognitionEvent('end', () => {
    clearStartTimeout()
    if (stateRef.current === 'transcribing' || stateRef.current === 'recording') {
      deliverTranscript()
    }
  })

  return {
    cancel,
    errorMessage,
    levels,
    requestSend: () => stop(true),
    retry,
    start,
    state,
    stop,
  }
}
