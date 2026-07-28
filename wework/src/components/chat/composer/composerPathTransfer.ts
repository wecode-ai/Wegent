import type { NativeWorkspacePath } from '@/lib/native-workspace-path-picker'
import type { ResolvedWorkspacePathTransfer } from '@/lib/workspace-path-transfer'
import { createComposerPathReference } from './composerMentions'

export function workspacePathReferenceText(entries: NativeWorkspacePath[]): string {
  return entries.map(entry => createComposerPathReference(entry.path, entry.isDirectory)).join(' ')
}

export function appendWorkspacePathReferences(
  value: string,
  entries: NativeWorkspacePath[]
): string {
  const references = workspacePathReferenceText(entries)
  if (!references) return value
  return value ? `${value}\n${references}` : references
}

export async function applyWorkspacePathTransfer(
  value: string,
  transfer: ResolvedWorkspacePathTransfer,
  onChange: (value: string) => void,
  onFileSelect?: (files: File[]) => void | Promise<void>
): Promise<string> {
  const nextValue = appendWorkspacePathReferences(value, transfer.referenceEntries)
  if (nextValue !== value) onChange(nextValue)
  if (transfer.attachmentFiles.length > 0) {
    try {
      await onFileSelect?.(transfer.attachmentFiles)
    } catch (error) {
      console.warn('[Wework composer] applying transferred attachments failed', error)
    }
  }
  return nextValue
}
