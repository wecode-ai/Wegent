import { createElement, Fragment, useState } from 'react'
import { Button } from '@/components/ui/button'

export default function CreatePluginAction({ onCreate, t }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return createElement(
    Fragment,
    null,
    createElement(
      Button,
      {
        type: 'button',
        variant: 'primary',
        disabled: busy || !onCreate,
        'data-testid': 'wework-plugin-developer-create-button',
        onClick: async () => {
          if (!onCreate || busy) return
          setBusy(true)
          setError('')
          try {
            await onCreate()
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
          } finally {
            setBusy(false)
          }
        },
      },
      busy
        ? t('workbench.plugin_development_creating', 'Creating…')
        : t('workbench.plugin_development_create', 'Create plugin')
    ),
    error
      ? createElement(
          'span',
          {
            'data-testid': 'wework-plugin-developer-create-error',
            className: 'ml-2 text-xs text-destructive',
          },
          error
        )
      : null
  )
}
