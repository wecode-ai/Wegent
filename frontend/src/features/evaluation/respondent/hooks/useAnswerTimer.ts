import { useState, useEffect, useMemo } from 'react'

export function useAnswerTimer() {
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [isRunning, setIsRunning] = useState(true)

  useEffect(() => {
    if (!isRunning) return

    const interval = setInterval(() => {
      setElapsedSeconds(s => s + 1)
    }, 1000)

    return () => clearInterval(interval)
  }, [isRunning])

  const formattedTime = useMemo(() => {
    const minutes = Math.floor(elapsedSeconds / 60)
    const seconds = elapsedSeconds % 60
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }, [elapsedSeconds])

  const pause = () => setIsRunning(false)
  const resume = () => setIsRunning(true)
  const reset = () => setElapsedSeconds(0)

  return {
    elapsedSeconds,
    formattedTime,
    pause,
    resume,
    reset,
  }
}
