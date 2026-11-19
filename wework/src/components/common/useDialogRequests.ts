import { useDialogRequests as useSharedDialogRequests } from '@wegent/collaboration/controls/useDialogRequests'

export function useDialogRequests(translate: (key: string, fallback: string) => string) {
  return useSharedDialogRequests(translate)
}
