export const LONG_PASTED_TEXT_ATTACHMENT_THRESHOLD = 4000

export function createLongPastedTextAttachment(text: string): File | null {
  if (text.length <= LONG_PASTED_TEXT_ATTACHMENT_THRESHOLD) return null

  return new File([text], `clipboard-text-${Date.now()}.txt`, {
    type: 'text/plain',
  })
}
