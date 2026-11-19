import { useCallback, useRef, useState } from 'react'
import { ConfirmationDialog } from './ConfirmationDialog'
import { TextInputDialog } from './TextInputDialog'

type Request = (
  | { kind: 'confirm'; message: string; resolve(value: boolean): void }
  | { kind: 'prompt'; message: string; initialValue: string; resolve(value: string | null): void }
) & { id: number }

export function useDialogRequests(translate: (key: string, fallback: string) => string) {
  const [queue, setQueue] = useState<Request[]>([])
  const sequence = useRef(0)
  const mounted = useRef(false)
  const pending = useRef(new Set<Request>())
  const enqueue = useCallback((request: Request) => {
    if (!mounted.current) {
      if (request.kind === 'confirm') request.resolve(false)
      else request.resolve(null)
      return
    }
    pending.current.add(request)
    setQueue(current => [...current, request])
  }, [])
  const confirm = useCallback(
    (message: string) =>
      new Promise<boolean>(resolve => {
        enqueue({ id: ++sequence.current, kind: 'confirm', message, resolve })
      }),
    [enqueue]
  )
  const prompt = useCallback(
    (message: string, initialValue = '') =>
      new Promise<string | null>(resolve => {
        enqueue({ id: ++sequence.current, kind: 'prompt', message, initialValue, resolve })
      }),
    [enqueue]
  )
  const attach = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    mounted.current = true
    const requests = pending.current
    return () => {
      mounted.current = false
      for (const request of requests) {
        if (request.kind === 'confirm') request.resolve(false)
        else request.resolve(null)
      }
      requests.clear()
    }
  }, [])
  const settle = (request: Request, value: string | boolean | null) => {
    if (!pending.current.delete(request)) return
    if (request.kind === 'confirm') request.resolve(value === true)
    else request.resolve(typeof value === 'string' ? value : null)
    setQueue(current => current.filter(item => item !== request))
  }
  const request = queue[0]
  const cancelLabel = translate('common.cancel', '取消')
  const confirmLabel = translate('common.confirm', '确认')
  const dialogs =
    request?.kind === 'confirm' ? (
      <ConfirmationDialog
        key={request.id}
        title={confirmLabel}
        subject={request.message}
        description=""
        testIdPrefix="confirmation-request"
        labels={{
          cancel: cancelLabel,
          confirm: confirmLabel,
          pending: translate('common.processing', '处理中'),
          failed: translate('workbench.save_failed', '保存失败'),
        }}
        onClose={() => settle(request, false)}
        onConfirm={async () => settle(request, true)}
      />
    ) : request?.kind === 'prompt' ? (
      <TextInputDialog
        key={request.id}
        open
        title={request.message}
        label={request.message}
        initialValue={request.initialValue}
        allowEmpty
        trimValue={false}
        failedLabel={translate('workbench.save_failed', '保存失败')}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        inputTestId="text-input-request"
        confirmTestId="text-input-request-confirm"
        onClose={() => settle(request, null)}
        onSubmit={value => settle(request, value)}
      />
    ) : null
  return { confirm, prompt, dialogs: <div className="contents" ref={attach}>{dialogs}</div> }
}
