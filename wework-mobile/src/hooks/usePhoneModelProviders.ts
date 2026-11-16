import { useCallback, useEffect, useState } from 'react'
import { phoneModelProviders, type PhoneProviderSnapshot } from '@/services/phoneModelProviders'

export function usePhoneModelProviders() {
  const [snapshot, setSnapshot] = useState<PhoneProviderSnapshot | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  useEffect(() => phoneModelProviders.subscribe(retry), [retry])
  useEffect(() => {
    let active = true
    void phoneModelProviders
      .providers()
      .then(value => {
        if (active) {
          setSnapshot(value)
          setError(null)
        }
      })
      .catch(cause => {
        if (active) setError(cause)
      })
    return () => {
      active = false
    }
  }, [attempt])
  return { snapshot, error, retry }
}
