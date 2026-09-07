import type {
  WeworkCommandDefinition,
  WeworkCommandHandler,
  WeworkComposerReferenceContribution,
  WeworkContextPrimitive,
  WeworkExtensionHost,
  WeworkKeybindingContribution,
  WeworkMenuContribution,
} from '../../../dsh/app-wework/client'

import type { Context } from '@deepseek-ai/cordis'
import type { DesktopPlatform } from '@/lib/platform'
import type { KeybindingCommand } from '@/lib/keybindings'

declare global {
  interface Window {
    __WEWORK_DSH_EXTENSIONS__?: WeworkExtensionHost
  }
}

export function getDshExtensionHost(): WeworkExtensionHost | null {
  return window.__WEWORK_DSH_EXTENSIONS__ ?? null
}

export function registerDshCommand(
  context: Context | null,
  definition: WeworkCommandDefinition,
  handler: WeworkCommandHandler
): () => void {
  if (!context?.wework) return () => {}
  return context.wework.commands.register(context, definition, handler)
}

export function registerDshContext(
  context: Context | null,
  key: string,
  value: WeworkContextPrimitive
): () => void {
  if (!context?.wework) return () => {}
  return context.wework.context.set(context, key, value)
}

export function registerDshComposerReference(
  context: Context | null,
  contribution: WeworkComposerReferenceContribution
): () => void {
  if (!context?.wework) return () => {}
  return context.wework.composer.references.register(context, contribution)
}

export function registerDshMenu(
  context: Context | null,
  location: string,
  contribution: WeworkMenuContribution
): () => void {
  if (!context?.wework) return () => {}
  return context.wework.menus.register(context, location, contribution)
}

export function registerDshKeybinding(
  context: Context | null,
  contribution: WeworkKeybindingContribution
): () => void {
  if (!context?.wework) return () => {}
  return context.wework.keybindings.register(context, contribution)
}

export async function executeDshCommand(
  id: string,
  args?: unknown,
  invocation?: Readonly<Record<string, unknown>>
): Promise<boolean> {
  const host = getDshExtensionHost()
  if (!host?.commands.get(id)) return false
  await host.commands.execute(id, args, invocation)
  return true
}

export function isDshCommandEnabled(id: string): boolean {
  const host = getDshExtensionHost()
  if (!host) return false
  const command = host.commands.get(id)
  return Boolean(command && host.context.matches(command.enablement))
}

export function subscribeDshExtensions(listener: () => void): () => void {
  const host = getDshExtensionHost()
  if (!host) return () => {}
  return host.subscribe(listener)
}

export function getDshKeybindingDefaults(platform: DesktopPlatform): readonly KeybindingCommand[] {
  const host = getDshExtensionHost()
  if (!host) return []
  return host.keybindings.list().map(binding => ({
    command: binding.command,
    defaultKey:
      platform === 'mac'
        ? (binding.mac ?? binding.key)
        : platform === 'win'
          ? (binding.windows ?? binding.key)
          : (binding.linux ?? binding.key),
  }))
}

export type {
  WeworkCommandDefinition,
  WeworkComposerReferenceContribution,
  WeworkContextExpression,
  WeworkKeybindingContribution,
  WeworkMenuContribution,
  WeworkResolvedMenuContribution,
  WeworkResolvedComposerReferenceContribution,
} from '../../../dsh/app-wework/client'
