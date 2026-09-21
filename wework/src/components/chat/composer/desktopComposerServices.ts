import type {
  ComposerEditorServices,
  ComposerTransferServices,
} from '@wegent/collaboration/composer'
import { isMainWindowFocused, subscribeMainWindowFocus } from '@/desktop/windowFocus'
import { readDroppedFiles } from '@/desktop/droppedFiles'
import { openNativeWorkspacePathPicker } from '@/lib/native-workspace-path-picker'
import { isElectronRuntime } from '@/lib/runtime-environment'
import {
  hasWorkspacePathDragData,
  readClipboardFileUriPaths,
  resolveDataTransferWorkspacePaths,
} from '@/lib/workspace-path-transfer'
import { resolveComposerMentionBrandIcon } from './composerMentions'

export async function pickComposerWorkspacePaths(initialDirectory?: string) {
  const entries = await openNativeWorkspacePathPicker(initialDirectory)
  return {
    referenceEntries: entries.filter(entry => entry.isDirectory),
    attachmentFiles: await readDroppedFiles(
      entries.filter(entry => !entry.isDirectory).map(entry => entry.path)
    ),
  }
}

export function getDesktopComposerEditorServices(): ComposerEditorServices {
  return {
    isWindowFocused: isMainWindowFocused,
    subscribeWindowFocus: subscribeMainWindowFocus,
    preserveNativeEmptyCaret: !isElectronRuntime(),
    resolveMentionIcon: resolveComposerMentionBrandIcon,
  }
}
export const desktopComposerTransferServices: ComposerTransferServices = {
  hasPathTransfer: data =>
    hasWorkspacePathDragData(data) || readClipboardFileUriPaths(data).length > 0,
  resolveTransfer: resolveDataTransferWorkspacePaths,
}
