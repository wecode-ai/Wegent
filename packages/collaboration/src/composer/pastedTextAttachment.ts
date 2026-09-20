export const LONG_PASTED_TEXT_ATTACHMENT_THRESHOLD = 5000;
const pastedTextFiles = new WeakSet<File>();

export function canRestorePastedText(characterCount: number): boolean {
  return (
    characterCount >= LONG_PASTED_TEXT_ATTACHMENT_THRESHOLD &&
    characterCount <= 25000
  );
}

export function isPastedTextFile(file: File): boolean {
  return pastedTextFiles.has(file);
}

export function createLongPastedTextAttachment(text: string): File | null {
  if (text.length < LONG_PASTED_TEXT_ATTACHMENT_THRESHOLD) return null;

  const file = new File([text], `clipboard-text-${Date.now()}.txt`, {
    type: "text/plain",
  });
  pastedTextFiles.add(file);
  return file;
}
