export const LIGHTWEIGHT_WORKBENCH_FRAME_NAME = 'wework-workbench-lightweight'

/** The surrounding DSH module is trusted; application HTML runs in an opaque frame. */
export function createLightweightClientSource(packageName: string, html: string): string {
  const sdk = `;
    let sequence=0,port=null,closed=false;const pending=new Map();
    function invoke(method,params={}){return new Promise((resolve,reject)=>{if(closed){reject(new Error('Workbench document is closed'));return}const id=++sequence;pending.set(id,{resolve,reject,method,params});port?.postMessage({id,method,params})})}
    addEventListener('message',event=>{
      if(closed||event.source!==parent||event.data?.channel!=='wework-workbench-connect')return;
      port?.close();const channel=new MessageChannel();port=channel.port1;
      port.onmessage=event=>{const request=pending.get(event.data?.id);if(!request)return;pending.delete(event.data.id);event.data.error?request.reject(new Error(event.data.error)):request.resolve(event.data.result)};
      port.start();parent.postMessage({channel:'wework-workbench-ready',token:documentToken},'*',[channel.port2]);
      for(const [id,{method,params}] of pending)port.postMessage({id,method,params});
    });
    addEventListener('pagehide',()=>{closed=true;port?.close();for(const request of pending.values())request.reject(new Error('Workbench document is closed'));pending.clear()},{once:true});
    window.weworkWorkbench=Object.freeze({
      storage:Object.freeze({get:()=>invoke('storage.get'),set:value=>invoke('storage.set',{value})}),
      notifications:Object.freeze({show:options=>invoke('notifications.show',options)}),
      clipboard:Object.freeze({readText:()=>invoke('clipboard.readText'),writeText:text=>invoke('clipboard.writeText',{text})}),
      files:Object.freeze({openText:()=>invoke('files.openText'),saveText:options=>invoke('files.saveText',options)}),
      external:Object.freeze({open:url=>invoke('external.open',{url})}),
      window:Object.freeze({hide:()=>invoke('window.hide'),setAlwaysOnTop:value=>invoke('window.setAlwaysOnTop',{value})})
    });
  })();`
  const prefix = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><script>(function(){const documentToken=`
  const suffix = `${sdk}</script>${html}`
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageName)},
  factory: require => {
    const React = require('react')
    function WorkbenchRoot() {
      const frame = React.useRef(null)
      const connection = React.useRef(null)
      const token = React.useRef(null)
      token.current ??= crypto.randomUUID()
      const attach = React.useCallback(element => {
        connection.current?.dispose()
        frame.current = element
        if (!element) { connection.current = null; return }
        const state = { loaded: false, closed: false, port: null, receive: null, dispose() {
          state.closed = true
          state.port?.close()
          state.port = null
          if (state.receive) removeEventListener('message', state.receive)
          state.receive = null
        } }
        connection.current = state
      }, [])
      const loaded = () => {
        const state = connection.current
        if (!state || state.closed) return
        if (state.loaded) { state.dispose(); return }
        state.loaded = true
        const source = frame.current.contentWindow
        state.receive = event => {
          if (state.closed || state.port || event.source !== source || event.origin !== 'null' || event.data?.channel !== 'wework-workbench-ready' || event.data.token !== token.current || event.ports.length !== 1) return
          const port = state.port = event.ports[0]
          removeEventListener('message', state.receive)
          state.receive = null
          port.onmessage = async event => {
            if (state.closed || state.port !== port) return
            const { id, method, params } = event.data ?? {}
            if (!Number.isSafeInteger(id) || typeof method !== 'string') return
            try {
              const response = await fetch('/wework/electron-host/v1/invoke', {
                method: 'POST', credentials: 'same-origin', cache: 'no-store',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ capability: 'workbench.invoke', params: { method, params } }),
              })
              const body = await response.json()
              if (!response.ok || body.ok === false) throw new Error(body.error?.message || 'Workbench capability failed')
              if (!state.closed && state.port === port) port.postMessage({ id, result: body.result })
            } catch (error) {
              if (!state.closed && state.port === port) port.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
            }
          }
          port.start()
        }
        addEventListener('message', state.receive)
        source.postMessage({ channel: 'wework-workbench-connect' }, '*')
      }
      return React.createElement('main', { 'data-testid': 'smart-app-ready' }, React.createElement('iframe', { ref: attach, onLoad: loaded, name: ${JSON.stringify(LIGHTWEIGHT_WORKBENCH_FRAME_NAME)}, sandbox: 'allow-scripts', title: 'Workbench', 'data-testid': 'workbench-lightweight-frame', srcDoc: ${JSON.stringify(prefix)} + JSON.stringify(token.current) + ${JSON.stringify(suffix)}, style: { border: 0, width: '100%', height: '100vh' } }))
    }
    return { inject: ['slots'], apply(ctx) { return ctx.slots.register({ name: 'root', priority: -1 }, WorkbenchRoot) } }
  },
})
`
}

export const LIGHTWEIGHT_HOST_SOURCE = 'export const inject = []\nexport function apply() {}\n'
