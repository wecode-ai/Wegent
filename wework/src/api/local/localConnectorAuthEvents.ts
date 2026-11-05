export const LOCAL_CONNECTOR_AUTH_CHANGED_EVENT = 'wework:local-connector-auth-changed'

export function notifyLocalConnectorAuthChanged(): void {
  window.dispatchEvent(new Event(LOCAL_CONNECTOR_AUTH_CHANGED_EVENT))
}
