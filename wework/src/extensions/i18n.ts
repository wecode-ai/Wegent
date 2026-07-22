export type ExtensionI18nResources = Partial<
  Record<'en' | 'zh-CN', Record<string, Record<string, unknown>>>
>

export const extensionI18nResources: ExtensionI18nResources = {}
