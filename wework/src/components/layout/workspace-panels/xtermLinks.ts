import { WebLinksAddon } from '@xterm/addon-web-links'
import { openExternalUrl } from '@/lib/external-links'

export function createXtermWebLinksAddon(): WebLinksAddon {
  return new WebLinksAddon((_event, uri) => {
    void openExternalUrl(uri).catch(error => {
      console.error('Failed to open terminal URL:', error)
    })
  })
}
