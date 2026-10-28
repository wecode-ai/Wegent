// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentLinkResource } from '../utils/documentLinkResource'
import {
  loadBoundedRemoteFile,
  prepareRemotePdf,
  probeRemoteVideo,
  RemoteFileError,
  type RemoteFileErrorCode,
} from '../utils/boundedRemoteFile'

export type DocumentLinkPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready'
      blob?: Blob
      blobUrl?: string
      mimeType: string
      size?: number
      supportsRange?: boolean
    }
  | {
      status: 'error'
      code:
        | RemoteFileErrorCode
        | 'expired'
        | 'unsupported-type'
        | 'parse-failed'
        | 'preview-failed'
        | 'codec-unsupported'
    }

export function useDocumentLinkPreview(resource: DocumentLinkResource | null) {
  const [state, setState] = useState<DocumentLinkPreviewState>({ status: 'idle' })
  const [retryKey, setRetryKey] = useState(0)
  const sequenceRef = useRef(0)

  useEffect(() => {
    if (!resource) {
      setState({ status: 'idle' })
      return
    }
    const sequence = ++sequenceRef.current
    const controller = new AbortController()
    let objectUrl: string | undefined
    setState({ status: 'loading' })

    const load = async () => {
      if (resource.expiresAt && resource.expiresAt <= Date.now()) {
        setState({ status: 'error', code: 'expired' })
        return
      }
      if (resource.kindHint === 'unknown') {
        setState({ status: 'error', code: 'unsupported-type' })
        return
      }
      try {
        if (resource.kindHint === 'pdf') {
          const result = await prepareRemotePdf(resource.url, controller.signal, resource.filename)
          if (sequence === sequenceRef.current) {
            setState({
              status: 'ready',
              blob: result.blob,
              mimeType: result.mimeType,
              size: result.size,
              supportsRange: result.supportsRange,
            })
          }
          return
        }
        if (resource.kindHint === 'video') {
          const result = await probeRemoteVideo(resource.url, controller.signal)
          if (sequence === sequenceRef.current) {
            setState({
              status: 'ready',
              mimeType: 'video/mp4',
              size: result.size,
              supportsRange: result.supportsRange,
            })
          }
          return
        }
        const result = await loadBoundedRemoteFile(
          resource.url,
          resource.kindHint,
          controller.signal,
          resource.filename
        )
        objectUrl = URL.createObjectURL(result.blob)
        if (sequence === sequenceRef.current) {
          setState({
            status: 'ready',
            blob: result.blob,
            blobUrl: objectUrl,
            mimeType: result.mimeType,
            size: result.size,
          })
        } else {
          URL.revokeObjectURL(objectUrl)
        }
      } catch (error) {
        if (controller.signal.aborted || sequence !== sequenceRef.current) return
        setState({
          status: 'error',
          code: error instanceof RemoteFileError ? error.code : 'network-or-cors',
        })
      }
    }
    void load()
    return () => {
      sequenceRef.current += 1
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [resource, retryKey])

  const fail = useCallback(
    (code: Extract<DocumentLinkPreviewState, { status: 'error' }>['code']) =>
      setState({ status: 'error', code }),
    []
  )

  return { state, retry: () => setRetryKey(value => value + 1), fail }
}
