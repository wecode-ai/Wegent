import en from './personalIssues.en.json'
import zh from './personalIssues.zh-CN.json'
import { createCollaborationTranslator, type CollaborationLocale } from '../i18n'
import { createContext, useContext } from 'react'

export const personalIssueMessages = { en, 'zh-CN': zh }

export function createPersonalIssueTranslator(locale: CollaborationLocale) {
  const messages = personalIssueMessages[locale] as Record<string, Record<string, string>>
  const translate = createCollaborationTranslator(locale)
  return (key: string, options?: Record<string, string | number>) => {
    const separator = key.indexOf('.')
    const text = messages[key.slice(0, separator)]?.[key.slice(separator + 1)]
    if (!text) return translate(key, undefined, options)
    return Object.entries(options ?? {}).reduce(
      (value, [name, replacement]) => value.replaceAll(`{{${name}}}`, String(replacement)),
      text
    )
  }
}

export const PersonalIssueTranslation = createContext(createPersonalIssueTranslator('en'))
export const usePersonalIssueTranslation = () => useContext(PersonalIssueTranslation)
