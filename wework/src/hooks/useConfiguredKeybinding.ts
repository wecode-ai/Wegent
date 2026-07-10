import { useEffect, useState } from 'react'
import { ACTIVE_KEYBINDINGS_CHANGED_EVENT, getActiveKeybinding } from '@/lib/keybindings'

export function useConfiguredKeybinding(command: string): string | null {
  const [keybinding, setKeybinding] = useState(() => getActiveKeybinding(command))

  useEffect(() => {
    const handleChanged = () => setKeybinding(getActiveKeybinding(command))
    window.addEventListener(ACTIVE_KEYBINDINGS_CHANGED_EVENT, handleChanged)
    handleChanged()
    return () => window.removeEventListener(ACTIVE_KEYBINDINGS_CHANGED_EVENT, handleChanged)
  }, [command])

  return keybinding
}
