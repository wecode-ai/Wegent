import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Keyboard, Linking } from 'react-native'
import { workspaceParentPath } from '../../../../packages/chat-core/src/workspace-file-paths'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import { mobileAttachmentRequest, mobileFileKey, resolveMobileFileLink } from '@/domain/mobileFiles'
import { MobileFileStore } from '@/services/mobileFileStore'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { LoadedMobileFile, MobileFileRequest, RecentMobileFile } from '@/types/files'
import { FilePreviewContext, type MobileFilePreviewActions } from './FilePreviewContext'
import { FileBrowserModal, type FileLocation } from './FileBrowserModal'

export function FilePreviewProvider({
  api,
  apiBaseUrl,
  target,
  children,
}: {
  api: RuntimeApi
  apiBaseUrl: string
  target: MobileWorkspaceFileTarget | null
  children: ReactNode
}) {
  const store = useMemo(() => new MobileFileStore(api), [api])
  const [locations, setLocations] = useState<FileLocation[]>([])
  const [recent, setRecent] = useState<RecentMobileFile[]>([])
  const opening = useRef(0)
  useEffect(
    () => () => {
      opening.current += 1
      store.dispose()
    },
    [store]
  )
  useEffect(
    () => () => {
      opening.current += 1
    },
    [target?.deviceId, target?.path]
  )
  const close = useCallback(() => {
    opening.current += 1
    setLocations([])
  }, [])
  const showError = useCallback((cause: unknown) => {
    Alert.alert('无法打开文件', cause instanceof Error ? cause.message : String(cause))
  }, [])
  const openFile = useCallback((request: MobileFileRequest) => {
    Keyboard.dismiss()
    opening.current += 1
    setLocations([{ kind: 'file', request }])
  }, [])
  const openLinkWithTarget = useCallback(
    async (href: string, owner: MobileWorkspaceFileTarget | null, withinBrowser = false) => {
      const sequence = ++opening.current
      try {
        const attachment = mobileAttachmentRequest(href, apiBaseUrl)
        if (attachment) {
          Keyboard.dismiss()
          setLocations(previous => [
            ...(withinBrowser ? previous : []),
            { kind: 'file', request: attachment },
          ])
          return
        }
        const resolved = resolveMobileFileLink(href, owner)
        if (resolved.kind === 'external') {
          await Linking.openURL(resolved.url)
          return
        }
        if (resolved.kind === 'none') return
        let location: FileLocation
        if (resolved.kind === 'directory') location = { kind: 'directory', target: resolved.target }
        else {
          const request = resolved.request
          location = { kind: 'file', request }
          if (request.kind === 'workspace' && !request.lineStart) {
            const listing = await api.listWorkspaceDirectory(
              request.target.deviceId,
              workspaceParentPath(request.path)
            )
            if (listing.entries.some(entry => entry.path === request.path && entry.isDirectory))
              location = { kind: 'directory', target: { ...request.target, path: request.path } }
          }
        }
        if (sequence !== opening.current) return
        Keyboard.dismiss()
        setLocations(previous => [...(withinBrowser ? previous : []), location])
      } catch (cause) {
        if (sequence === opening.current) showError(cause)
      }
    },
    [api, apiBaseUrl, showError]
  )
  const actions = useMemo<MobileFilePreviewActions>(
    () => ({
      target,
      openFile,
      openBrowser: () => {
        Keyboard.dismiss()
        opening.current += 1
        if (!target) {
          showError(new Error('当前会话尚无可访问的文件目录'))
          return
        }
        setLocations([{ kind: 'directory', target }])
      },
      openLink: href => {
        void openLinkWithTarget(href, target)
      },
      openWorkspaceFile: (path, lineStart, lineEnd) => {
        try {
          const resolved = resolveMobileFileLink(path, target)
          if (resolved.kind !== 'file' || resolved.request.kind !== 'workspace') return
          openFile({
            ...resolved.request,
            lineStart: lineStart ?? resolved.request.lineStart,
            lineEnd: lineEnd ?? resolved.request.lineEnd,
          })
        } catch (cause) {
          showError(cause)
        }
      },
      openAttachment: attachment => openFile({ kind: 'attachment', attachment }),
      openChanges: (summary, path) => openFile({ kind: 'diff', summary, path }),
    }),
    [target, openFile, openLinkWithTarget, showError]
  )

  const remember = useCallback((request: MobileFileRequest, document: LoadedMobileFile) => {
    const key = mobileFileKey(request)
    setRecent(previous =>
      [
        {
          key,
          request,
          name: document.name,
          path: document.path,
          position: previous.find(item => item.key === key)?.position ?? 0,
        },
        ...previous.filter(item => item.key !== key),
      ].slice(0, 30)
    )
  }, [])
  const position = useCallback((request: MobileFileRequest, value: number) => {
    const key = mobileFileKey(request)
    setRecent(previous =>
      previous.map(item => (item.key === key ? { ...item, position: value } : item))
    )
  }, [])

  return (
    <FilePreviewContext.Provider value={actions}>
      {children}
      {locations.length > 0 ? (
        <FileBrowserModal
          api={api}
          apiBaseUrl={apiBaseUrl}
          store={store}
          location={locations.at(-1)!}
          recent={recent}
          onClose={close}
          onBack={() => {
            opening.current += 1
            setLocations(current => current.slice(0, -1))
          }}
          onNavigate={location => {
            opening.current += 1
            setLocations(current => [...current, location])
          }}
          onLoaded={remember}
          onPositionChange={position}
          onLink={(href, owner) => {
            void openLinkWithTarget(href, owner, true)
          }}
        />
      ) : null}
    </FilePreviewContext.Provider>
  )
}
