import { useState, useEffect, useCallback } from 'react'

interface DraftData {
  text: string
  attachments: Array<{ key: string; filename: string; file_size: number }>
  savedAt: string
}

export function useQuestionDraft(questionId: number) {
  const storageKey = `evaluation_draft_${questionId}`

  const [draft, setDraft] = useState<DraftData | null>(null)
  const [lastSaved, setLastSaved] = useState<string | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        setDraft(parsed)
        setLastSaved(parsed.savedAt)
      } catch {
        // Invalid draft data, ignore
      }
    }
  }, [storageKey])

  const saveDraft = useCallback(
    (text: string, attachments: DraftData['attachments']) => {
      const data: DraftData = {
        text,
        attachments,
        savedAt: new Date().toISOString(),
      }
      localStorage.setItem(storageKey, JSON.stringify(data))
      setLastSaved(data.savedAt)
    },
    [storageKey]
  )

  const clearDraft = useCallback(() => {
    localStorage.removeItem(storageKey)
    setDraft(null)
    setLastSaved(null)
  }, [storageKey])

  return {
    draft,
    lastSaved,
    saveDraft,
    clearDraft,
  }
}
