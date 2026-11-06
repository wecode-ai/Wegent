/** Closing a UI reader cancels its work without immediately releasing admission. */
export function isTranscriptReadAdmissionBusy(status, text) {
  if (status !== 502) return false
  try {
    return (
      JSON.parse(text)?.detail ===
      'Transcript processing is busy; try again when the current read finishes'
    )
  } catch {
    return false
  }
}
