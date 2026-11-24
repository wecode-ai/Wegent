import {
  BROWSER_DOWNLOAD_SNAPSHOT_SIZE,
  browserDownloadSnapshot,
  isLiveDownload,
  listEmbeddedBrowserDownloads,
  type EmbeddedBrowserDownloadEvent,
} from '@/lib/embedded-browser'
import { readEmbeddedBrowserDownloadSnapshot } from '@/lib/embedded-browser-download-store'
import type { BrowserSessionModel } from './workspaceBrowserSessionTypes'

export function createBrowserDownloads(model: BrowserSessionModel) {
  const unreadDownloads = new Set<string>()
  const markDownloadRead = (id: string) => {
    if (unreadDownloads.delete(id)) model.set('unreadDownloadCount', unreadDownloads.size)
  }
  const markDownloadsRead = () => {
    unreadDownloads.clear()
    model.set('unreadDownloadCount', 0)
  }
  let snapshotRevision = -1
  let historyStatusRevision = -1
  let pendingEvents: Map<string, EmbeddedBrowserDownloadEvent> | undefined
  const applyDownloadHistoryStatus = (revision: number, historyUnavailable: boolean) => {
    if (revision < historyStatusRevision) return
    historyStatusRevision = revision
    model.set('downloadsError', historyUnavailable)
  }
  const refreshDownloads = async () => {
    const pending = new Map<string, EmbeddedBrowserDownloadEvent>()
    const historyRevisionAtStart = historyStatusRevision
    pendingEvents = pending
    model.set('downloadsLoading', true)
    try {
      const snapshot = await listEmbeddedBrowserDownloads()
      if (!model.observed || pendingEvents !== pending || !model.state.downloadsOpen) return
      snapshotRevision = snapshot.revision
      const records = new Map(snapshot.downloads.map(record => [record.id, record]))
      for (const event of pending.values()) {
        if (event.revision <= snapshotRevision) continue
        if (event.status === 'deleted') records.delete(event.id)
        else records.set(event.id, event)
      }
      model.set('downloads', browserDownloadSnapshot(records.values()))
      applyDownloadHistoryStatus(snapshot.revision, snapshot.historyUnavailable)
    } catch (error) {
      if (pendingEvents !== pending || !model.observed || !model.state.downloadsOpen) return
      if (historyRevisionAtStart === historyStatusRevision) model.set('downloadsError', true)
      console.error('[Wework] Failed to read browser downloads', error)
    } finally {
      if (pendingEvents === pending) {
        pendingEvents = undefined
        model.set('downloadsLoading', false)
      }
    }
  }
  const applyDownloadEvent = (download: EmbeddedBrowserDownloadEvent): void => {
    const owned = download.nativeLabel === model.runtime.nativeLabel
    if (download.revision <= snapshotRevision) return
    const fillVacancy =
      download.status === 'deleted' &&
      model.state.downloadsOpen &&
      model.options.active &&
      model.state.downloads.length >= BROWSER_DOWNLOAD_SNAPSHOT_SIZE
    if (model.state.downloadsOpen || owned) {
      pendingEvents?.set(download.id, download)
      model.set('downloads', current => {
        const remaining = current.filter(item => item.id !== download.id)
        if (download.status === 'deleted') return remaining
        return browserDownloadSnapshot([...remaining, download])
      })
    }
    if (download.status === 'deleted') {
      if (fillVacancy) void refreshDownloads()
      if (model.state.downloadPeek?.id === download.id) model.set('downloadPeek', null)
      markDownloadRead(download.id)
    }
    if (!owned || model.state.downloadsOpen || !model.options.active) return
    if (download.status === 'finished' || download.status === 'failed') {
      if (download.status === 'finished') {
        unreadDownloads.add(download.id)
        model.set('unreadDownloadCount', unreadDownloads.size)
      }
      model.set('downloadPeek', {
        id: download.id,
        fileName: download.fileName,
        path: download.path,
        status: download.status,
      })
    }
  }
  const clearDownloadHistory = (revision: number) => {
    if (revision <= snapshotRevision) return
    snapshotRevision = revision
    pendingEvents = undefined
    model.set('downloads', current => current.filter(isLiveDownload))
    model.set('downloadPeek', null)
    markDownloadsRead()
    if (model.options.active && model.state.downloadsOpen) void refreshDownloads()
    else model.set('downloadsLoading', false)
  }
  const reconcileDownloadSnapshot = (nativeLabel: string): void => {
    const snapshot = readEmbeddedBrowserDownloadSnapshot(nativeLabel)
    if (!model.state.downloadsOpen) model.set('downloads', snapshot)
    model.runtime.activeDownloadIds = new Set(
      snapshot
        .filter(download => download.status === 'started' || download.status === 'progress')
        .map(download => download.id)
    )
    model.options.onDownloadActivityChange?.(model.runtime.activeDownloadIds.size > 0)
  }

  return {
    applyDownloadEvent,
    applyDownloadHistoryStatus,
    clearDownloadHistory,
    markDownloadRead,
    markDownloadsRead,
    reconcileDownloadSnapshot,
    refreshDownloads,
  }
}
