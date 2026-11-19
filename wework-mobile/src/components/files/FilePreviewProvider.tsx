import { showErrorAlert } from '@/services/errorAlerts'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Keyboard, Linking } from 'react-native'
import { workspaceParentPath } from '../../../../packages/chat-core/src/workspace-file-paths'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'
import {
  isPhoneLocalFile,
  mobileAttachmentRequest,
  mobileFileKey,
  resolveMobileFileLink,
} from '@/domain/mobileFiles'
import { isPhoneLocalDeviceId } from '@/services/localRuntime'
import { MobileFileStore } from '@/services/mobileFileStore'
import { loadMobileWorkspaceChanges } from '@/services/mobileWorkspaceGit'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { LoadedMobileFile, MobileFileRequest, RecentMobileFile } from '@/types/files'
import { FilePreviewContext, type MobileFilePreviewActions } from './FilePreviewContext'
import { FileBrowserModal, type FileLocation } from './FileBrowserModal'

export function FilePreviewProvider({
  api,
  apiBaseUrl,
  target: targetSnapshot,
  backendSession = apiBaseUrl,
  children,
}: {
  api: RuntimeApi
  apiBaseUrl: string
  target: MobileWorkspaceFileTarget | null
  backendSession?: string | null
  children: ReactNode
}) {
  // Work-list refreshes may create a new object for the same file owner.
  // Consumers must observe ownership changes, not snapshot object identity.
  const deviceId = targetSnapshot?.deviceId
  const path = targetSnapshot?.path
  const taskId = targetSnapshot?.taskId
  const workspaceSource = targetSnapshot?.workspaceSource
  const target = useMemo<MobileWorkspaceFileTarget | null>(
    () =>
      deviceId !== undefined && path !== undefined
        ? {
            deviceId,
            path,
            ...(taskId !== undefined && { taskId }),
            ...(workspaceSource !== undefined && { workspaceSource }),
          }
        : null,
    [deviceId, path, taskId, workspaceSource]
  )
  const store = useMemo(() => new MobileFileStore(api), [api])
  const [locations, setLocations] = useState<FileLocation[]>([])
  const [recent, setRecent] = useState<RecentMobileFile[]>([])
  const opening = useRef(0)
  const currentBackend = useRef(backendSession)
  currentBackend.current = backendSession
  const previousBackend = useRef(backendSession)
  useLayoutEffect(() => {
    if (previousBackend.current === backendSession) return
    previousBackend.current = backendSession
    store.retain(isPhoneLocalFile)
    setRecent(current => current.filter(item => isPhoneLocalFile(item.request)))
    setLocations(current =>
      current.filter(location =>
        location.kind === 'file'
          ? isPhoneLocalFile(location.request)
          : isPhoneLocalDeviceId(location.target.deviceId)
      )
    )
  }, [backendSession, store])
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
    showErrorAlert(cause, { title: '无法打开文件' })
  }, [])
  const openFile = useCallback(
    (request: MobileFileRequest) => {
      Keyboard.dismiss()
      opening.current += 1
      if (request.kind === 'git-diff') store.invalidate(request)
      setLocations([{ kind: 'file', request }])
    },
    [store]
  )
  const openLinkWithTarget = useCallback(
    async (href: string, owner: MobileWorkspaceFileTarget | null, withinBrowser = false) => {
      const sequence = ++opening.current
      const stillOwned = () =>
        currentBackend.current === backendSession || isPhoneLocalDeviceId(owner?.deviceId)
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
              workspaceParentPath(request.path),
              request.target.path,
              request.target.taskId
            )
            if (listing.entries.some(entry => entry.path === request.path && entry.isDirectory))
              location = { kind: 'directory', target: { ...request.target, path: request.path } }
          }
        }
        if (sequence !== opening.current || !stillOwned()) return
        Keyboard.dismiss()
        setLocations(previous => [...(withinBrowser ? previous : []), location])
      } catch (cause) {
        if (sequence === opening.current && stillOwned()) showError(cause)
      }
    },
    [api, apiBaseUrl, backendSession, showError]
  )
  const actions = useMemo<MobileFilePreviewActions>(
    () => ({
      target,
      openFile,
      loadChanges: (selection, signal) => {
        if (!target) return Promise.reject(new Error('当前会话尚无可访问的文件目录'))
        return loadMobileWorkspaceChanges(api, target, selection, signal)
      },
      openBrowser: () => {
        Keyboard.dismiss()
        opening.current += 1
        if (!target) {
          showError(new Error('当前会话尚无可访问的文件目录'))
          return
        }
        setLocations([{ kind: 'directory', target }])
      },
      openChangesBrowser: (selection = { mode: 'branch' }) => {
        Keyboard.dismiss()
        opening.current += 1
        if (!target) {
          showError(new Error('当前会话尚无可访问的文件目录'))
          return
        }
        setLocations([{ kind: 'changes', target, selection }])
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
      openChanges: (summary, path) =>
        openFile({ kind: 'diff', summary, path, taskId: target?.taskId }),
    }),
    [api, target, openFile, openLinkWithTarget, showError]
  )

  const remember = useCallback(
    (request: MobileFileRequest, document: LoadedMobileFile) => {
      if (backendSession !== currentBackend.current && !isPhoneLocalFile(request)) return
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
    },
    [backendSession]
  )
  const position = useCallback(
    (request: MobileFileRequest, value: number) => {
      if (backendSession !== currentBackend.current && !isPhoneLocalFile(request)) return
      const key = mobileFileKey(request)
      setRecent(previous =>
        previous.map(item => (item.key === key ? { ...item, position: value } : item))
      )
    },
    [backendSession]
  )

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
            if (location.kind === 'file' && location.request.kind === 'git-diff')
              store.invalidate(location.request)
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
