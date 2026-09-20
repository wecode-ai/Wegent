import type {
  ComposerEditorServices,
  ComposerTransferServices,
} from '@wegent/collaboration/composer'
import { isMainWindowFocused, subscribeMainWindowFocus } from '@/desktop/windowFocus'
import { isElectronRuntime } from '@/lib/runtime-environment'
import {
  hasWorkspacePathDragData,
  resolveDataTransferWorkspacePaths,
} from '@/lib/workspace-path-transfer'
import { resolveComposerMentionBrandIcon } from './composerMentions'

export function getDesktopComposerEditorServices(): ComposerEditorServices {
  return {
    isWindowFocused: isMainWindowFocused,
    subscribeWindowFocus: subscribeMainWindowFocus,
    preserveNativeEmptyCaret: !isElectronRuntime(),
    resolveMentionIcon: resolveComposerMentionBrandIcon,
  }
}
export const desktopComposerTransferServices: ComposerTransferServices = {
  hasPathTransfer: hasWorkspacePathDragData,
  resolveTransfer: resolveDataTransferWorkspacePaths,
}
