import { useEffect, useState } from 'react'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'

export function InteractionProbe({
  onChange,
}: {
  onChange: (value: ReturnType<typeof useRuntimeInteractions>) => void
}) {
  const value = useRuntimeInteractions()
  useEffect(() => onChange(value), [onChange, value])
  return null
}

export function UnrelatedForm() {
  const [value, setValue] = useState('')
  return (
    <input aria-label="Connection address" value={value} onChange={e => setValue(e.target.value)} />
  )
}
