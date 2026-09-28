import type { ReactNode } from 'react'
import { ToolInteractionServicesProvider } from '@wegent/collaboration/conversation'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { navigateTo } from '@/lib/navigation'
import { track } from '@/telemetry/client'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'
import { useDesktopMarkdownServices } from './useDesktopMarkdownServices'
const services = {
  openProxySettings: () => navigateTo('/settings/personal/proxy'),
  onOutputAction: (action: 'copy' | 'open_file') =>
    track('ai_output_action_completed', { action, source: 'chat' }),
}
export function DesktopToolServices({ children }: { children: ReactNode }) {
  const markdown = useDesktopMarkdownServices()
  return (
    <DesktopConversationTranslation>
      <MarkdownServicesProvider value={markdown}>
        <ToolInteractionServicesProvider value={services}>
          {children}
        </ToolInteractionServicesProvider>
      </MarkdownServicesProvider>
    </DesktopConversationTranslation>
  )
}
