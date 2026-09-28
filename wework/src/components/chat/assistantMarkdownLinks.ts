import { isElectronRuntime } from '@/lib/runtime-environment'
import {
  localHtmlBrowserUrl as browserUrl,
  resolveDirectMarkdownImageSrc as imageSrc,
} from '@wegent/collaboration/markdown/assistantMarkdownLinks'
export * from '@wegent/collaboration/markdown/assistantMarkdownLinks'
export const localHtmlBrowserUrl = (path: string) => browserUrl(path, isElectronRuntime())
export const resolveDirectMarkdownImageSrc = (src: string) => imageSrc(src, isElectronRuntime())
