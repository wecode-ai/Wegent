import { useCallback, useState, useSyncExternalStore } from 'react'
import { useDOMEvent, useDocumentEvent } from '@wegent/collaboration/dom-events'
import { APP_PREFERENCES_CHANGED_EVENT } from '@/desktop/appPreferences'
import { SELECTED_TEXT_CHANGED_EVENT } from '@/lib/selected-text-drag'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { SelectionActionsPopover } from '@/components/chat/SelectionActionsPopover'
import { createSystemDragSelectionSource } from './systemDragSelectionSource'

const SELECTION_ACTION_GAP = 8

export function SystemDragBridge() {
  const workbench = useWorkbench()
  const [source] = useState(createSystemDragSelectionSource)
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(workbench, listener),
    [source, workbench]
  )
  const selection = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  useDOMEvent('window', APP_PREFERENCES_CHANGED_EVENT, source.preferencesChanged)
  useDOMEvent('window', SELECTED_TEXT_CHANGED_EVENT, source.selectedTextChanged)
  useDocumentEvent('selectionchange', source.scheduleSelection)
  useDocumentEvent('pointerup', source.finalizeSelection)
  useDocumentEvent('keyup', source.finalizeSelection)
  useDocumentEvent('dragstart', source.dragStart)
  useDocumentEvent('dragend', source.dragEnd)
  return selection ? (
    <SelectionActionsPopover
      position={{
        left: Math.min(
          Math.max(selection.rect.left + selection.rect.width / 2, 120),
          window.innerWidth - 120
        ),
        top: Math.max(selection.rect.top - SELECTION_ACTION_GAP, 44),
      }}
      onAddToConversation={source.addSelectionToConversation}
      testId="workspace-selection-actions"
      addButtonTestId="add-workspace-selection-to-conversation-button"
    />
  ) : null
}
