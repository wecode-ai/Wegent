import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { useImperativeHandle, useState, type Ref } from 'react'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'

export interface InteractionProbeHandle {
  value: ReturnType<typeof useRuntimeInteractions>
}

export function InteractionProbe({ ref }: { ref: Ref<InteractionProbeHandle> }) {
  const value = useRuntimeInteractions()
  useImperativeHandle(ref, () => ({ value }), [value])
  return null
}

export function UnrelatedForm() {
  const [value, setValue] = useState('')
  return (
    <ControlInput
      aria-label="Connection address"
      value={value}
      onChange={e => setValue(e.target.value)}
    />
  )
}
