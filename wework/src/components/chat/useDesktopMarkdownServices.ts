import { useMemo } from 'react'
import {
  browserMarkdownServices,
  markdownMessages,
  type MarkdownServices,
} from '@wegent/collaboration/markdown'
import { useTranslation } from '@/hooks/useTranslation'
import { useOptionalAppearance } from '@/features/appearance'
import { getRuntimeConfig } from '@/config/runtime'
import { copyTextToClipboard } from '@/lib/clipboard'
import { openExternalUrl } from '@/lib/external-links'
import { requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'
import { readElectronLocalFile } from '@/lib/electron-local-file'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { navigateTo } from '@/lib/navigation'
import { track } from '@/telemetry/client'
import { CodexInlineVisualizationHost } from './CodexInlineVisualizationHost'
import { createElement } from 'react'
import { useAttachmentDownload } from './AttachmentDownloadContext'

const readLocalFile = async (path: string) => new Blob([await readElectronLocalFile(path)])
const onCopy = () => track('ai_output_action_completed', { action: 'copy', source: 'chat' })

export function useDesktopMarkdownServices(): MarkdownServices {
  const { t: chatTranslate } = useTranslation('chat')
  const { t: commonTranslate, i18n } = useTranslation('common')
  const theme = useOptionalAppearance()?.resolvedMode ?? 'system'
  const fetchAttachmentBlob = useAttachmentDownload()
  const plantumlServerUrl = getRuntimeConfig().plantumlServerUrl
  return useMemo(
    () => ({
      ...browserMarkdownServices,
      translate: (key: string, fallback?: string) =>
        key.startsWith('table.')
          ? chatTranslate(key)
          : key.startsWith('code.')
            ? markdownMessages[i18n?.language?.startsWith('zh') ? 'zh-CN' : 'en'][
                key as keyof typeof markdownMessages.en
              ]
            : fallback === undefined
              ? commonTranslate(key)
              : commonTranslate(key, fallback),
      copyText: copyTextToClipboard,
      onCopy,
      openExternalUrl,
      navigateTo,
      openHtmlFile: requestEmbeddedBrowserOpen,
      fetchAttachmentBlob,
      readLocalFile: isElectronRuntime() ? readLocalFile : undefined,
      windowMarkdown: isElectronRuntime(),
      renderVisualization: part => createElement(CodexInlineVisualizationHost, part),
      theme,
      plantumlServerUrl,
    }),
    [chatTranslate, commonTranslate, i18n?.language, theme, fetchAttachmentBlob, plantumlServerUrl]
  )
}
