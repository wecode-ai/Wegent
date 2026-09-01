import { useEffect } from 'react'
import {
  recordIdleTaskUserActivity,
  startIdleTaskScheduler,
  stopIdleTaskScheduler,
} from './idleTaskScheduler'

const USER_ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'touchstart', 'wheel'] as const

export function IdleTaskCoordinator({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) {
      stopIdleTaskScheduler()
      return undefined
    }

    const recordActivity = () => recordIdleTaskUserActivity()
    USER_ACTIVITY_EVENTS.forEach(event => {
      window.addEventListener(event, recordActivity, { passive: true, capture: true })
    })
    startIdleTaskScheduler()

    return () => {
      stopIdleTaskScheduler()
      USER_ACTIVITY_EVENTS.forEach(event => {
        window.removeEventListener(event, recordActivity, true)
      })
    }
  }, [active])

  return null
}
