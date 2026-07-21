import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  Globe2,
  CircleAlert,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { cloudDesktopExtension } from '@extensions/cloud-desktop'
import {
  canUseEmbeddedBrowser,
  closeEmbeddedBrowser,
  consumeEmbeddedBrowserLabelTransfer,
  deleteEmbeddedBrowserDownload,
  EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT,
  EMBEDDED_BROWSER_OCCLUSION_EVENT,
  evalEmbeddedBrowser,
  evalEmbeddedBrowserJson,
  goBackEmbeddedBrowser,
  goForwardEmbeddedBrowser,
  navigateEmbeddedBrowser,
  openEmbeddedBrowser,
  pauseEmbeddedBrowserDownload,
  readEmbeddedBrowserPageState,
  reloadEmbeddedBrowser,
  resumeEmbeddedBrowserDownload,
  setEmbeddedBrowserBounds,
  type EmbeddedBrowserBounds,
  type EmbeddedBrowserDownloadEvent,
  type EmbeddedBrowserOcclusionChange,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import {
  readEmbeddedBrowserDownloadSnapshot,
  subscribeEmbeddedBrowserDownloadEvents,
} from '@/lib/embedded-browser-download-store'
import { openExternalUrl } from '@/lib/external-links'
import { revealLocalFile } from '@/lib/local-terminal'
import { normalizeBrowserUrl } from '@/lib/browser-url'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodeCommentContext } from '@/types/workspace-files'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import {
  DEFAULT_UI_FONT_SIZE,
  resolveUiTypographyVariables,
} from '@/features/appearance/typography'

const EMBEDDED_BROWSER_READY_TIMEOUT_MS = 800
const EMBEDDED_BROWSER_STATE_INTERVAL_MS = 1000
const EMBEDDED_BROWSER_BOUNDS_DEBOUNCE_MS = 80
const EMBEDDED_BROWSER_HOST_BOUNDS_TIMEOUT_MS = 5000
const EMBEDDED_BROWSER_HOST_BOUNDS_INTERVAL_MS = 50
const EMBEDDED_BROWSER_POST_OPEN_SYNC_DELAYS_MS = [0, 120, 300, 600]
const BROWSER_ANNOTATION_LOG_PREFIX = '[Wework][BrowserAnnotation]'
const BROWSER_ANNOTATION_CLEANUP_SCRIPT = `(() => {
  try { window.__weworkBrowserAnnotationClear?.(); } catch (_) {}
  try { window.__weworkBrowserAnnotationClose?.(); } catch (_) {}
  document.getElementById('__wework_browser_annotation_layer__')?.remove();
  document.querySelectorAll('[data-wework-annotation]').forEach((node) => node.remove());
  return true;
})()`

interface WorkspaceBrowserPanelProps {
  active: boolean
  label?: string
  openRequest?: (EmbeddedBrowserOpenRequest & { id: number }) | null
  codeCommentCount?: number
  onAddCodeComment?: (context: CodeCommentContext) => void
  onFaviconChange?: (faviconUrl: string | null) => void
  onTitleChange?: (title: string | null) => void
}

type BrowserStatus = 'idle' | 'loading' | 'ready' | 'error'
type BrowserDownload = EmbeddedBrowserDownloadEvent
type BrowserAnnotationRect = { x: number; y: number; width: number; height: number }
type BrowserAnnotation = BrowserAnnotationRect & {
  id: string
  comment: string
  number: number
}

function logBrowserAnnotation(message: string, data?: Record<string, unknown>) {
  console.info(BROWSER_ANNOTATION_LOG_PREFIX, message, data ?? {})
}

function getFallbackBrowserTitle(url: string) {
  try {
    const parsedUrl = new URL(url)
    return parsedUrl.hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

function getFallbackFaviconUrl(url: string) {
  try {
    return new URL('/favicon.ico', url).toString()
  } catch {
    return null
  }
}

function formatDownloadBytes(bytes: number | null) {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function getElementBounds(element: HTMLElement): EmbeddedBrowserBounds | null {
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }
}

function waitForElementBounds(
  getElement: () => HTMLElement | null,
  isDisposed: () => boolean
): Promise<EmbeddedBrowserBounds> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let timer: number | null = null
    const finish = (callback: () => void) => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      callback()
    }

    const check = () => {
      if (isDisposed()) {
        finish(() => reject(new Error('Embedded browser open was cancelled')))
        return
      }

      const element = getElement()
      const bounds = element ? getElementBounds(element) : null
      if (bounds) {
        finish(() => resolve(bounds))
        return
      }

      if (Date.now() - startedAt >= EMBEDDED_BROWSER_HOST_BOUNDS_TIMEOUT_MS) {
        finish(() => reject(new Error('Timed out waiting for embedded browser host bounds')))
        return
      }

      timer = window.setTimeout(check, EMBEDDED_BROWSER_HOST_BOUNDS_INTERVAL_MS)
    }

    timer = window.setTimeout(check, 0)
  })
}

function observeElementIfPresent(observer: ResizeObserver, element: Element | null) {
  if (element) observer.observe(element)
}

// Exported for DOM-level regression tests of the injected browser behavior.
// eslint-disable-next-line react-refresh/only-export-components
export function browserAnnotationInjectionScript(uiFontSize = DEFAULT_UI_FONT_SIZE) {
  const typography = resolveUiTypographyVariables(uiFontSize)
  return String.raw`
(() => {
  const log = (message, data = {}) => {
    console.info('[Wework][BrowserAnnotation][page]', message, data);
  };

  // Tear down any previous annotation session completely (listeners + DOM).
  // Removing only the layer leaves stale capture listeners that can recreate boxes.
  if (typeof window.__weworkBrowserAnnotationClose === 'function') {
    log('close previous annotation session before reinject');
    try {
      window.__weworkBrowserAnnotationClose();
    } catch (error) {
      log('previous annotation session close failed', {
        error: String(error?.stack || error?.message || error),
      });
    }
  }
  document.getElementById('__wework_browser_annotation_layer__')?.remove();
  document.querySelectorAll('[data-wework-annotation]').forEach((node) => node.remove());

  const state = {
    nextNumber: 1,
    published: [],
    draftBox: null,
    hoverBox: null,
    activeElement: null,
    activeEditor: null,
    activeInput: null,
  };
  const isAnnotationLayerTarget = (target) =>
    target instanceof Element && target.closest('#__wework_browser_annotation_layer__');

  const layer = document.createElement('div');
  layer.id = '__wework_browser_annotation_layer__';
  Object.assign(layer.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    background: 'transparent',
    pointerEvents: 'none',
    userSelect: 'none',
  });

  const makeBox = (rect) => {
    const box = document.createElement('div');
    box.dataset.weworkAnnotation = 'box';
    Object.assign(box.style, {
      position: 'fixed',
      left: rect.x + 'px',
      top: rect.y + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
      border: '2px solid #1683ff',
      background: 'rgba(147, 197, 253, 0.45)',
      boxSizing: 'border-box',
      pointerEvents: 'none',
    });
    return box;
  };

  const elementRect = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.max(1, Math.min(rect.width, window.innerWidth - Math.max(0, rect.left))),
      height: Math.max(1, Math.min(rect.height, window.innerHeight - Math.max(0, rect.top))),
    };
  };

  const updateHoverBox = (element) => {
    const rect = elementRect(element);
    if (!state.hoverBox) {
      state.hoverBox = makeBox(rect);
      state.hoverBox.dataset.weworkAnnotation = 'hover';
      state.hoverBox.style.background = 'rgba(147, 197, 253, 0.28)';
      layer.appendChild(state.hoverBox);
    }
    Object.assign(state.hoverBox.style, {
      left: rect.x + 'px',
      top: rect.y + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    });
  };

  const clearHoverBox = () => {
    state.hoverBox?.remove();
    state.hoverBox = null;
  };

  const removeAnnotationVisualNodes = (root) => {
    root.querySelectorAll('[data-wework-annotation="editor"]').forEach((node) => node.remove());
    root.querySelectorAll('[data-wework-annotation="box"]').forEach((node) => node.remove());
    root.querySelectorAll('[data-wework-annotation="hover"]').forEach((node) => node.remove());
  };

  const clearAnnotationVisuals = () => {
    clearHoverBox();
    // Clear both the live layer and any orphaned nodes left outside it.
    // Orphans can remain when a previous injection session leaked boxes.
    removeAnnotationVisualNodes(layer);
    removeAnnotationVisualNodes(document);
    state.nextNumber = 1;
    state.published.length = 0;
    state.draftBox = null;
    state.activeEditor = null;
    state.activeInput = null;
    state.activeElement = null;
  };

  window.__weworkBrowserAnnotationConsume = () => {
    const items = state.published.slice();
    state.published.length = 0;
    if (items.length > 0) {
      log('consume published annotations', { count: items.length, comments: items.map((item) => item.comment) });
    }
    return items;
  };
  window.__weworkBrowserAnnotationClear = () => {
    log('clear annotations');
    clearAnnotationVisuals();
  };

  const validTarget = (target) => {
    if (!(target instanceof Element)) return null;
    if (isAnnotationLayerTarget(target)) return null;
    if (target === document.documentElement || target === document.body) return null;
    return target;
  };

  const showEditor = (element) => {
    const rect = elementRect(element);
    log('open editor', {
      tagName: element.tagName?.toLowerCase?.(),
      text: (element.innerText || element.textContent || '').trim().slice(0, 120),
      rect,
    });
    clearHoverBox();
    const draftBox = makeBox(rect);
    state.draftBox = draftBox;
    layer.appendChild(draftBox);

    const editor = document.createElement('div');
    Object.assign(editor.style, {
      position: 'fixed',
      left: Math.min(rect.x + 8, Math.max(8, window.innerWidth - 300)) + 'px',
      top: Math.min(rect.y + 28, Math.max(8, window.innerHeight - 52)) + 'px',
      width: '280px',
      height: '40px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '0 10px',
      borderRadius: '999px',
      border: '1px solid rgba(0,0,0,0.12)',
      background: 'white',
      boxShadow: '0 12px 30px rgba(0,0,0,0.16)',
      boxSizing: 'border-box',
      cursor: 'default',
      pointerEvents: 'auto',
    });
    editor.dataset.weworkAnnotation = 'editor';

    const input = document.createElement('input');
    input.placeholder = '添加评论...';
    Object.assign(input.style, {
      minWidth: '0',
      flex: '1',
      height: '28px',
      border: '0',
      outline: '0',
      fontSize: ${JSON.stringify(typography['--text-base'])},
      background: 'transparent',
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '发布';
    Object.assign(button.style, {
      border: '0',
      borderRadius: '999px',
      background: '#1683ff',
      color: 'white',
      height: '28px',
      padding: '0 10px',
      fontSize: ${JSON.stringify(typography['--text-xs'])},
      cursor: 'pointer',
    });

    const closeEditor = (removeDraft) => {
      editor.remove();
      if (removeDraft) {
        draftBox.remove();
      }
      if (state.draftBox === draftBox) {
        state.draftBox = null;
      }
      if (state.activeEditor === editor) {
        state.activeEditor = null;
        state.activeInput = null;
      }
    };

    const publish = () => {
      const comment = input.value.trim();
      if (!comment) return;
      const number = state.nextNumber++;
      const badge = document.createElement('span');
      badge.textContent = String(number);
      Object.assign(badge.style, {
        position: 'absolute',
        right: '4px',
        top: '4px',
        minWidth: '20px',
        height: '20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '999px',
        background: '#1683ff',
        color: 'white',
        fontSize: ${JSON.stringify(typography['--text-xs'])},
        fontWeight: '700',
        padding: '0 4px',
      });
      draftBox.appendChild(badge);
      const annotation = {
        id: 'browser-annotation-' + Date.now() + '-' + number,
        number,
        comment,
        tagName: element.tagName.toLowerCase(),
        text: (element.innerText || element.textContent || '').trim().slice(0, 500),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
      state.published.push(annotation);
      log('publish annotation', annotation);
      closeEditor(false);
    };

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      publish();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        event.stopPropagation();
        publish();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeEditor(true);
      }
    });
    editor.addEventListener('pointerdown', (event) => event.stopPropagation());
    editor.addEventListener('mousedown', (event) => event.stopPropagation());
    editor.addEventListener('click', (event) => event.stopPropagation());
    editor.append(input, button);
    layer.appendChild(editor);
    state.activeEditor = editor;
    state.activeInput = input;
    input.focus();
  };

  const handleMouseMove = (event) => {
    if (state.draftBox) return;
    const target = validTarget(event.target);
    if (!target) {
      clearHoverBox();
      return;
    }
    state.activeElement = target;
    updateHoverBox(target);
  };

  const keepDraftFocus = (event) => {
    if (!state.draftBox) return false;
    const target = event.target;
    if (isAnnotationLayerTarget(target)) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    state.activeInput?.focus();
    return true;
  };

  const handlePointerDown = (event) => {
    keepDraftFocus(event);
  };

  const handleClick = (event) => {
    if (keepDraftFocus(event)) return;
    if (isAnnotationLayerTarget(event.target)) return;
    const target = validTarget(event.target) || state.activeElement;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    showEditor(target);
  };

  const cleanup = () => {
    log('cleanup annotation layer');
    document.removeEventListener('pointerdown', handlePointerDown, true);
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    clearAnnotationVisuals();
    layer.remove();
    // Defensive: remove any orphaned annotation nodes left outside the layer.
    document.getElementById('__wework_browser_annotation_layer__')?.remove();
    document.querySelectorAll('[data-wework-annotation]').forEach((node) => node.remove());
    delete window.__weworkBrowserAnnotationConsume;
    delete window.__weworkBrowserAnnotationClose;
    delete window.__weworkBrowserAnnotationClear;
  };

  window.__weworkBrowserAnnotationClose = cleanup;

  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);

  document.documentElement.appendChild(layer);
  log('annotation layer installed', { url: window.location.href });
  return true;
})();`
}

function browserAnnotationContext(
  annotation: BrowserAnnotation,
  url: string | null,
  title: string | null
): CodeCommentContext {
  const browserUrl = url ?? 'about:blank'
  const fallbackName = (() => {
    try {
      return new URL(browserUrl).hostname || browserUrl
    } catch {
      return browserUrl
    }
  })()
  return {
    id: annotation.id,
    filePath: `browser:${browserUrl}`,
    fileName: title || fallbackName,
    startLine: annotation.number,
    endLine: annotation.number,
    selectedText: JSON.stringify(
      {
        type: 'browser_annotation',
        url: browserUrl,
        title,
        rect: {
          x: Math.round(annotation.x),
          y: Math.round(annotation.y),
          width: Math.round(annotation.width),
          height: Math.round(annotation.height),
        },
      },
      null,
      2
    ),
    comment: annotation.comment,
    createdAt: new Date().toISOString(),
  }
}

export function WorkspaceBrowserPanel({
  active,
  label = 'workspace-browser',
  openRequest,
  codeCommentCount = 0,
  onAddCodeComment,
  onFaviconChange,
  onTitleChange,
}: WorkspaceBrowserPanelProps) {
  const { t } = useTranslation('common')
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const browserHostRef = useRef<HTMLDivElement | null>(null)
  const nativeBrowserOpenRef = useRef(false)
  const currentUrlRef = useRef<string | null>(null)
  const activePageUrlRef = useRef<string | null>(null)
  const annotationModeRef = useRef(false)
  const annotationCleanupPromiseRef = useRef<Promise<void> | null>(null)
  const annotationInjectionOwnerRef = useRef<number | null>(null)
  const annotationRequestGenerationRef = useRef(0)
  const currentLabelRef = useRef(label)
  const activeRef = useRef(active)
  const nativeLabelRef = useRef<string | null>(null)
  const adoptedDownloadOwnerLabelRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const pageStateRequestGenerationRef = useRef(0)
  const previousCodeCommentCountRef = useRef(codeCommentCount)
  const handledOpenRequestIdRef = useRef<number | null>(null)
  const syncBoundsTimerRef = useRef<number | null>(null)
  const syncBoundsAnimationFrameRef = useRef<number | null>(null)
  const postOpenSyncTimerRefs = useRef<number[]>([])
  const annotationEmptyPollLogCountRef = useRef(0)
  const [occludingOverlayIds, setOccludingOverlayIds] = useState<Set<string>>(() => new Set())
  const [address, setAddress] = useState('')
  const [currentUrl, setCurrentUrl] = useState<string | null>(null)
  const [pageUrl, setPageUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<BrowserStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotations, setAnnotations] = useState<BrowserAnnotation[]>([])
  const [downloads, setDownloads] = useState<BrowserDownload[]>([])
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const embeddedBrowserAvailable = canUseEmbeddedBrowser()
  const activePageUrl = pageUrl ?? currentUrl
  const internalDesktopPage = Boolean(
    activePageUrl && cloudDesktopExtension.isInternalPageUrl(activePageUrl)
  )
  const embeddedBrowserOccluded = occludingOverlayIds.size > 0

  const applyDownloadEvent = useCallback((download: EmbeddedBrowserDownloadEvent) => {
    setDownloads(current => {
      const remaining = current.filter(item => item.id !== download.id)
      if (download.status === 'deleted') return remaining
      return [download, ...remaining].slice(0, 10)
    })
    setDownloadsOpen(true)
  }, [])

  const reconcileDownloadSnapshot = useCallback((nativeLabel: string) => {
    const snapshot = readEmbeddedBrowserDownloadSnapshot(nativeLabel).slice(0, 10)
    setDownloads(snapshot)
    setDownloadsOpen(snapshot.length > 0)
  }, [])

  const adoptNativeLabel = useCallback(
    (nativeLabel: string, logicalLabel: string) => {
      if (
        nativeLabelRef.current === nativeLabel &&
        adoptedDownloadOwnerLabelRef.current === logicalLabel
      ) {
        return
      }

      nativeLabelRef.current = nativeLabel
      adoptedDownloadOwnerLabelRef.current = logicalLabel
      reconcileDownloadSnapshot(nativeLabel)
    },
    [reconcileDownloadSnapshot]
  )

  useLayoutEffect(() => {
    mountedRef.current = true
    currentLabelRef.current = label
    activeRef.current = active
    pageStateRequestGenerationRef.current += 1
    annotationRequestGenerationRef.current += 1
    return () => {
      mountedRef.current = false
      pageStateRequestGenerationRef.current += 1
      annotationRequestGenerationRef.current += 1
    }
  }, [active, label])

  useEffect(() => {
    return subscribeEmbeddedBrowserDownloadEvents(download => {
      if (!activeRef.current || download.nativeLabel !== nativeLabelRef.current) return
      applyDownloadEvent(download)
    })
  }, [applyDownloadEvent])

  useEffect(() => {
    if (!active || !nativeLabelRef.current) return
    reconcileDownloadSnapshot(nativeLabelRef.current)
  }, [active, reconcileDownloadSnapshot])

  const updatePageUrl = useCallback(
    (url: string | null) => {
      activePageUrlRef.current = url
      setPageUrl(url)
      if (url) {
        setAddress(url)
        onTitleChange?.(getFallbackBrowserTitle(url))
        onFaviconChange?.(getFallbackFaviconUrl(url))
        return
      }

      onTitleChange?.(null)
      onFaviconChange?.(null)
    },
    [onFaviconChange, onTitleChange]
  )

  const syncEmbeddedBrowserBounds = useCallback(
    async (visible = active) => {
      if (!embeddedBrowserAvailable || !nativeBrowserOpenRef.current) return
      const host = browserHostRef.current
      if (!host) {
        if (!visible) {
          await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, label)
        }
        return
      }
      const bounds = getElementBounds(host)
      if (!bounds) {
        if (!visible) {
          await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, label)
        }
        return
      }
      await setEmbeddedBrowserBounds(bounds, visible && !embeddedBrowserOccluded, label)
    },
    [active, embeddedBrowserAvailable, embeddedBrowserOccluded, label]
  )

  const hideEmbeddedBrowser = useCallback(async () => {
    if (!embeddedBrowserAvailable || !nativeBrowserOpenRef.current) return
    await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, label)
  }, [embeddedBrowserAvailable, label])

  const cleanupAnnotationLayer = useCallback((targetLabel: string) => {
    const previousCleanup = annotationCleanupPromiseRef.current ?? Promise.resolve()
    const cleanupPromise = previousCleanup
      .then(() => evalEmbeddedBrowser(BROWSER_ANNOTATION_CLEANUP_SCRIPT, targetLabel))
      .then(() => undefined)
      .catch(error => {
        console.error('Failed to close embedded browser annotation layer:', error)
      })
    annotationCleanupPromiseRef.current = cleanupPromise
    void cleanupPromise.finally(() => {
      if (annotationCleanupPromiseRef.current === cleanupPromise) {
        annotationCleanupPromiseRef.current = null
      }
    })
    return cleanupPromise
  }, [])

  const cleanupInvalidatedAnnotationRequest = useCallback(
    async (requestGeneration: number, targetLabel: string) => {
      if (
        !mountedRef.current ||
        currentLabelRef.current !== targetLabel ||
        annotationInjectionOwnerRef.current !== requestGeneration
      ) {
        return
      }
      annotationInjectionOwnerRef.current = null
      await cleanupAnnotationLayer(targetLabel)
    },
    [cleanupAnnotationLayer]
  )

  const exitAnnotationMode = useCallback(() => {
    logBrowserAnnotation('exit annotation mode', {
      label,
      currentUrl,
      nativeBrowserOpen: nativeBrowserOpenRef.current,
    })
    annotationRequestGenerationRef.current += 1
    annotationModeRef.current = false
    setAnnotationMode(false)
    setAnnotations([])
    // Clear visuals first, then close the session. Also remove any orphaned
    // annotation nodes so published boxes cannot linger after mode exit.
    void cleanupAnnotationLayer(label)
  }, [cleanupAnnotationLayer, currentUrl, label])

  const enterAnnotationMode = useCallback(async () => {
    logBrowserAnnotation('enter annotation mode requested', {
      label,
      active,
      currentUrl,
      embeddedBrowserAvailable,
      nativeBrowserOpen: nativeBrowserOpenRef.current,
    })
    if (
      internalDesktopPage ||
      !embeddedBrowserAvailable ||
      !nativeBrowserOpenRef.current ||
      !currentUrl
    ) {
      logBrowserAnnotation('enter annotation mode skipped', {
        label,
        active,
        currentUrl,
        embeddedBrowserAvailable,
        nativeBrowserOpen: nativeBrowserOpenRef.current,
      })
      return
    }
    const requestGeneration = annotationRequestGenerationRef.current + 1
    annotationRequestGenerationRef.current = requestGeneration
    try {
      const pendingCleanup = annotationCleanupPromiseRef.current
      if (pendingCleanup) {
        await pendingCleanup
      }
      if (
        !mountedRef.current ||
        currentLabelRef.current !== label ||
        annotationRequestGenerationRef.current !== requestGeneration
      ) {
        return
      }
      annotationInjectionOwnerRef.current = requestGeneration
      await evalEmbeddedBrowser(browserAnnotationInjectionScript(appearance.uiFontSize), label)
      if (
        !mountedRef.current ||
        currentLabelRef.current !== label ||
        annotationRequestGenerationRef.current !== requestGeneration
      ) {
        await cleanupInvalidatedAnnotationRequest(requestGeneration, label)
        return
      }
      if (
        activePageUrlRef.current &&
        cloudDesktopExtension.isInternalPageUrl(activePageUrlRef.current)
      ) {
        exitAnnotationMode()
        return
      }
      annotationEmptyPollLogCountRef.current = 0
      annotationModeRef.current = true
      setAnnotationMode(true)
      logBrowserAnnotation('enter annotation mode succeeded', { label, currentUrl })
    } catch (error) {
      if (
        !mountedRef.current ||
        currentLabelRef.current !== label ||
        annotationRequestGenerationRef.current !== requestGeneration
      ) {
        await cleanupInvalidatedAnnotationRequest(requestGeneration, label)
        return
      }
      annotationInjectionOwnerRef.current = null
      console.error('Failed to enter embedded browser annotation mode:', error)
      logBrowserAnnotation('enter annotation mode failed', {
        label,
        currentUrl,
        error: error instanceof Error ? error.message : String(error),
      })
      setStatus('error')
      setError(t('workbench.browser_annotation_failed'))
    }
  }, [
    active,
    appearance.uiFontSize,
    currentUrl,
    cleanupInvalidatedAnnotationRequest,
    embeddedBrowserAvailable,
    exitAnnotationMode,
    internalDesktopPage,
    label,
    t,
  ])

  useEffect(() => {
    const previousCount = previousCodeCommentCountRef.current
    previousCodeCommentCountRef.current = codeCommentCount
    // After annotations are sent (or cleared from composer), leave annotation mode
    // and remove any remaining page selection boxes.
    if (previousCount > 0 && codeCommentCount === 0 && annotationMode) {
      exitAnnotationMode()
    }
  }, [annotationMode, codeCommentCount, exitAnnotationMode])

  const clearScheduledBoundsSync = useCallback(() => {
    if (syncBoundsAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(syncBoundsAnimationFrameRef.current)
      syncBoundsAnimationFrameRef.current = null
    }
    if (syncBoundsTimerRef.current !== null) {
      window.clearTimeout(syncBoundsTimerRef.current)
      syncBoundsTimerRef.current = null
    }
    postOpenSyncTimerRefs.current.forEach(timer => window.clearTimeout(timer))
    postOpenSyncTimerRefs.current = []
  }, [])

  const scheduleEmbeddedBrowserBoundsSync = useCallback(
    (visible = active) => {
      if (syncBoundsAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(syncBoundsAnimationFrameRef.current)
        syncBoundsAnimationFrameRef.current = null
      }
      if (syncBoundsTimerRef.current !== null) {
        window.clearTimeout(syncBoundsTimerRef.current)
        syncBoundsTimerRef.current = null
      }

      syncBoundsAnimationFrameRef.current = window.requestAnimationFrame(() => {
        syncBoundsAnimationFrameRef.current = null
        void syncEmbeddedBrowserBounds(visible).catch(error => {
          console.error('Failed to sync embedded browser bounds:', error)
        })
      })
      syncBoundsTimerRef.current = window.setTimeout(() => {
        syncBoundsTimerRef.current = null
        void syncEmbeddedBrowserBounds(visible).catch(error => {
          console.error('Failed to sync embedded browser bounds:', error)
        })
      }, EMBEDDED_BROWSER_BOUNDS_DEBOUNCE_MS)
    },
    [active, syncEmbeddedBrowserBounds]
  )

  const schedulePostOpenBoundsSync = useCallback(
    (visible = active) => {
      EMBEDDED_BROWSER_POST_OPEN_SYNC_DELAYS_MS.forEach(delay => {
        const timer = window.setTimeout(() => {
          postOpenSyncTimerRefs.current = postOpenSyncTimerRefs.current.filter(
            pendingTimer => pendingTimer !== timer
          )
          scheduleEmbeddedBrowserBoundsSync(visible)
        }, delay)
        postOpenSyncTimerRefs.current.push(timer)
      })
    },
    [active, scheduleEmbeddedBrowserBoundsSync]
  )

  useEffect(() => clearScheduledBoundsSync, [clearScheduledBoundsSync])

  const refreshPageState = useCallback(async (): Promise<boolean> => {
    if (!embeddedBrowserAvailable || !nativeBrowserOpenRef.current) return false
    const requestGeneration = pageStateRequestGenerationRef.current + 1
    pageStateRequestGenerationRef.current = requestGeneration
    try {
      const pageState = await readEmbeddedBrowserPageState(label)
      if (!mountedRef.current || pageStateRequestGenerationRef.current !== requestGeneration) {
        return false
      }
      adoptNativeLabel(pageState.nativeLabel, label)
      const nextUrl = pageState.url || currentUrlRef.current
      if (
        nextUrl &&
        cloudDesktopExtension.isInternalPageUrl(nextUrl) &&
        annotationModeRef.current
      ) {
        logBrowserAnnotation('exit annotation mode for internal desktop page', { label })
        exitAnnotationMode()
      }
      updatePageUrl(nextUrl)
      if (nextUrl) {
        onTitleChange?.(pageState.title || getFallbackBrowserTitle(nextUrl))
        onFaviconChange?.(getFallbackFaviconUrl(nextUrl))
      }
      return true
    } catch (error) {
      if (!mountedRef.current || pageStateRequestGenerationRef.current !== requestGeneration) {
        return false
      }
      console.error('Failed to read embedded browser page state:', error)
      return false
    }
  }, [
    embeddedBrowserAvailable,
    adoptNativeLabel,
    exitAnnotationMode,
    label,
    onFaviconChange,
    onTitleChange,
    updatePageUrl,
  ])

  useEffect(() => {
    currentUrlRef.current = currentUrl
  }, [currentUrl])

  useEffect(() => {
    if (!active || !embeddedBrowserAvailable || !currentUrl) return
    if (nativeBrowserOpenRef.current) {
      schedulePostOpenBoundsSync(active)
      return
    }

    let disposed = false
    let readyTimer: number | null = null

    setStatus('loading')
    const openWhenHostIsReady = async () => {
      try {
        const bounds = await waitForElementBounds(
          () => browserHostRef.current,
          () => disposed
        )
        if (disposed) return

        readyTimer = window.setTimeout(() => {
          if (!disposed) setStatus('ready')
        }, EMBEDDED_BROWSER_READY_TIMEOUT_MS)

        const pageState = await openEmbeddedBrowser(currentUrl, bounds, label)
        if (disposed) {
          await closeEmbeddedBrowser(label).catch(() => undefined)
          return
        }
        adoptNativeLabel(pageState.nativeLabel, label)
        nativeBrowserOpenRef.current = true
        updatePageUrl(pageState.url || currentUrl)
        schedulePostOpenBoundsSync(active)
        if (readyTimer !== null) window.clearTimeout(readyTimer)
        setStatus('ready')
      } catch (error) {
        console.error('Failed to open embedded browser:', error)
        if (!disposed) {
          if (readyTimer !== null) window.clearTimeout(readyTimer)
          setStatus('error')
          setError(t('workbench.browser_open_failed'))
        }
      }
    }

    void openWhenHostIsReady()

    return () => {
      disposed = true
      if (readyTimer !== null) window.clearTimeout(readyTimer)
    }
  }, [
    active,
    adoptNativeLabel,
    currentUrl,
    embeddedBrowserAvailable,
    label,
    schedulePostOpenBoundsSync,
    t,
    updatePageUrl,
  ])

  useEffect(() => {
    if (!active || !embeddedBrowserAvailable || nativeBrowserOpenRef.current || currentUrl) return

    let disposed = false

    const attachExistingBrowser = async () => {
      try {
        const pageState = await readEmbeddedBrowserPageState(label)
        if (disposed) return
        adoptNativeLabel(pageState.nativeLabel, label)
        if (!pageState.url) return
        nativeBrowserOpenRef.current = true
        setCurrentUrl(pageState.url)
        updatePageUrl(pageState.url)
        if (pageState.title) {
          onTitleChange?.(pageState.title)
        }
        setStatus('ready')
        schedulePostOpenBoundsSync(active)
      } catch {
        // No existing native browser for this label.
      }
    }

    void attachExistingBrowser()

    return () => {
      disposed = true
    }
  }, [
    active,
    adoptNativeLabel,
    currentUrl,
    embeddedBrowserAvailable,
    label,
    onTitleChange,
    schedulePostOpenBoundsSync,
    updatePageUrl,
  ])

  useEffect(() => {
    if (!embeddedBrowserAvailable) return

    if (!active) {
      void hideEmbeddedBrowser().catch(error => {
        console.error('Failed to hide embedded browser:', error)
      })
      return
    }

    scheduleEmbeddedBrowserBoundsSync(active)
  }, [active, embeddedBrowserAvailable, hideEmbeddedBrowser, scheduleEmbeddedBrowserBoundsSync])

  useEffect(() => {
    if (!embeddedBrowserAvailable) return

    const handlePageHide = () => {
      void hideEmbeddedBrowser().catch(error => {
        console.error('Failed to hide embedded browser before page unload:', error)
      })
    }
    const handlePageShow = () => {
      if (activeRef.current) scheduleEmbeddedBrowserBoundsSync(true)
    }

    window.addEventListener('pagehide', handlePageHide)
    window.addEventListener('pageshow', handlePageShow)
    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [embeddedBrowserAvailable, hideEmbeddedBrowser, scheduleEmbeddedBrowserBoundsSync])

  useEffect(() => {
    if (!embeddedBrowserAvailable || !currentUrl) return
    const host = browserHostRef.current
    if (!host) return

    const handleBoundsChange = () => scheduleEmbeddedBrowserBoundsSync(active)
    const observer = new ResizeObserver(handleBoundsChange)
    observeElementIfPresent(observer, host)
    observeElementIfPresent(observer, host.parentElement)
    observeElementIfPresent(observer, document.documentElement)
    window.addEventListener('resize', handleBoundsChange)
    window.visualViewport?.addEventListener('resize', handleBoundsChange)
    schedulePostOpenBoundsSync(active)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleBoundsChange)
      window.visualViewport?.removeEventListener('resize', handleBoundsChange)
      clearScheduledBoundsSync()
    }
  }, [
    active,
    clearScheduledBoundsSync,
    currentUrl,
    embeddedBrowserAvailable,
    scheduleEmbeddedBrowserBoundsSync,
    schedulePostOpenBoundsSync,
  ])

  useEffect(() => {
    if (!active || !embeddedBrowserAvailable || !nativeBrowserOpenRef.current) return

    const intervalId = window.setInterval(() => {
      void refreshPageState()
    }, EMBEDDED_BROWSER_STATE_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [active, embeddedBrowserAvailable, refreshPageState, status])

  useEffect(() => {
    if (
      !active ||
      !annotationMode ||
      internalDesktopPage ||
      !embeddedBrowserAvailable ||
      !nativeBrowserOpenRef.current
    ) {
      if (annotationMode) {
        logBrowserAnnotation('consume effect inactive', {
          label,
          active,
          annotationMode,
          embeddedBrowserAvailable,
          nativeBrowserOpen: nativeBrowserOpenRef.current,
        })
      }
      return
    }

    logBrowserAnnotation('consume effect active', {
      label,
      activePageUrl,
      hasAddCodeComment: Boolean(onAddCodeComment),
    })
    let cancelled = false

    const consumeAnnotations = async () => {
      try {
        const published = await evalEmbeddedBrowserJson<BrowserAnnotation[]>(
          'window.__weworkBrowserAnnotationConsume?.() ?? []',
          label
        )
        if (cancelled) return
        if (!Array.isArray(published)) {
          logBrowserAnnotation('consume returned non-array payload', {
            label,
            payloadType: typeof published,
          })
          return
        }
        if (published.length === 0) {
          if (annotationEmptyPollLogCountRef.current < 5) {
            annotationEmptyPollLogCountRef.current += 1
            logBrowserAnnotation('consume returned no annotations', {
              label,
              emptyPollCount: annotationEmptyPollLogCountRef.current,
            })
          }
          return
        }
        logBrowserAnnotation('consume returned annotations', {
          label,
          count: published.length,
          comments: published.map(annotation => annotation.comment),
          hasAddCodeComment: Boolean(onAddCodeComment),
        })
        setAnnotations(current => [...current, ...published])
        published.forEach(annotation => {
          logBrowserAnnotation('forward annotation to workbench', {
            label,
            annotationId: annotation.id,
            number: annotation.number,
            commentLength: annotation.comment.length,
          })
          onAddCodeComment?.(
            browserAnnotationContext(
              annotation,
              activePageUrl,
              activePageUrl ? getFallbackBrowserTitle(activePageUrl) : null
            )
          )
        })
      } catch (error) {
        if (cancelled) return
        console.error('Failed to consume embedded browser annotations:', error)
        logBrowserAnnotation('consume annotations failed', {
          label,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const intervalId = window.setInterval(() => {
      void consumeAnnotations()
    }, 500)
    void consumeAnnotations()

    return () => {
      cancelled = true
      logBrowserAnnotation('consume effect cleanup', { label })
      window.clearInterval(intervalId)
    }
  }, [
    active,
    activePageUrl,
    annotationMode,
    embeddedBrowserAvailable,
    internalDesktopPage,
    label,
    onAddCodeComment,
  ])

  useEffect(() => {
    return () => {
      nativeBrowserOpenRef.current = false
      if (consumeEmbeddedBrowserLabelTransfer(label)) return
      nativeLabelRef.current = null
      adoptedDownloadOwnerLabelRef.current = null
      void closeEmbeddedBrowser(label).catch(() => undefined)
    }
  }, [label])

  useEffect(() => {
    const handleDebugPanelVisibility = (event: Event) => {
      const expanded = Boolean((event as CustomEvent<{ expanded?: boolean }>).detail?.expanded)
      setOccludingOverlayIds(current => {
        const next = new Set(current)
        if (expanded) {
          next.add('debug-panel')
        } else {
          next.delete('debug-panel')
        }
        return next
      })
    }

    const handleBrowserOcclusion = (event: Event) => {
      const detail = (event as CustomEvent<EmbeddedBrowserOcclusionChange>).detail
      if (!detail?.id) return

      setOccludingOverlayIds(current => {
        const next = new Set(current)
        if (detail.occluded) {
          next.add(detail.id)
        } else {
          next.delete(detail.id)
        }
        return next
      })
    }

    window.addEventListener(
      EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT,
      handleDebugPanelVisibility
    )
    window.addEventListener(EMBEDDED_BROWSER_OCCLUSION_EVENT, handleBrowserOcclusion)
    return () => {
      window.removeEventListener(
        EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT,
        handleDebugPanelVisibility
      )
      window.removeEventListener(EMBEDDED_BROWSER_OCCLUSION_EVENT, handleBrowserOcclusion)
    }
  }, [label])

  useEffect(() => {
    void syncEmbeddedBrowserBounds(active).catch(error => {
      console.error('Failed to sync embedded browser occlusion visibility:', error)
    })
  }, [active, embeddedBrowserOccluded, syncEmbeddedBrowserBounds])

  const runBrowserCommand = useCallback(
    async (command: () => Promise<void>) => {
      if (!currentUrl) return
      try {
        await command()
        if (!(await refreshPageState())) return
        setStatus('ready')
      } catch (error) {
        console.error('Failed to control embedded browser:', error)
        setStatus('error')
        setError(t('workbench.browser_control_failed'))
      }
    },
    [currentUrl, refreshPageState, t]
  )

  const reloadCurrentUrl = useCallback(
    (url: string) => {
      if (!embeddedBrowserAvailable) {
        setCurrentUrl(null)
        window.setTimeout(() => setCurrentUrl(url), 0)
        return
      }

      void runBrowserCommand(() => reloadEmbeddedBrowser(label))
    },
    [embeddedBrowserAvailable, label, runBrowserCommand]
  )

  const openBrowserUrl = useCallback(
    (rawUrl: string) => {
      const nextUrl = normalizeBrowserUrl(rawUrl, window.location.href)
      if (!nextUrl) {
        setStatus('error')
        setError(t('workbench.browser_invalid_url'))
        return
      }

      setAddress(nextUrl)
      setError(null)
      pageStateRequestGenerationRef.current += 1

      if (annotationMode && cloudDesktopExtension.isInternalPageUrl(nextUrl)) {
        exitAnnotationMode()
      }

      if (nextUrl === activePageUrl) {
        setStatus('ready')
        updatePageUrl(nextUrl)
        reloadCurrentUrl(nextUrl)
        return
      }

      updatePageUrl(nextUrl)

      if (embeddedBrowserAvailable && nativeBrowserOpenRef.current) {
        setStatus('loading')
        void runBrowserCommand(() => navigateEmbeddedBrowser(nextUrl, label)).then(() => {
          setCurrentUrl(nextUrl)
        })
        return
      }

      setCurrentUrl(nextUrl)
      setStatus(embeddedBrowserAvailable ? 'loading' : 'ready')
    },
    [
      activePageUrl,
      annotationMode,
      embeddedBrowserAvailable,
      exitAnnotationMode,
      label,
      reloadCurrentUrl,
      runBrowserCommand,
      t,
      updatePageUrl,
    ]
  )

  useEffect(() => {
    if (!openRequest?.url) return
    if (openRequest.label && openRequest.label !== label) return
    if (handledOpenRequestIdRef.current === openRequest.id) return
    handledOpenRequestIdRef.current = openRequest.id
    openBrowserUrl(openRequest.url)
  }, [label, openBrowserUrl, openRequest?.id, openRequest?.label, openRequest?.url])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    openBrowserUrl(address)
  }

  const handleReload = () => {
    if (!activePageUrl) return
    reloadCurrentUrl(activePageUrl)
  }

  const handleOpenExternal = () => {
    if (!activePageUrl || internalDesktopPage) return
    void openExternalUrl(activePageUrl, { target: 'system' })
  }

  return (
    <div
      data-testid="workspace-browser-panel"
      className={cn(
        'flex h-full min-h-0 w-full flex-col bg-background text-text-primary',
        !active && 'hidden'
      )}
    >
      {annotationMode && !internalDesktopPage ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-blue-200 bg-blue-50 px-2 text-sm text-text-primary">
          <BrowserToolbarButton
            testId="workspace-browser-annotation-close-button"
            label={t('workbench.browser_annotation_close')}
            onClick={exitAnnotationMode}
          >
            <X className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-annotation-clear-button"
            label={t('workbench.browser_annotation_clear')}
            onClick={() => {
              setAnnotations([])
              // Prefer the injected Clear (resets numbering/state). Always also
              // wipe visual nodes from the document so orphaned boxes cannot stay
              // after the toolbar count already cleared.
              void evalEmbeddedBrowser(
                `(() => {
                  try { window.__weworkBrowserAnnotationClear?.(); } catch (_) {}
                  document
                    .querySelectorAll('[data-wework-annotation="box"], [data-wework-annotation="hover"], [data-wework-annotation="editor"]')
                    .forEach((node) => node.remove());
                  return true;
                })()`,
                label
              ).catch(error => {
                console.error('Failed to clear embedded browser annotations:', error)
              })
            }}
          >
            <Trash2 className="h-4 w-4" />
          </BrowserToolbarButton>
          <div className="min-w-0 flex-1 truncate text-center font-medium">
            {t('workbench.browser_annotation_active', {
              site: activePageUrl ? getFallbackBrowserTitle(activePageUrl) : t('workbench.browser'),
            })}
          </div>
          {annotations.length > 0 ? (
            <span
              data-testid="workspace-browser-annotation-count"
              className="rounded-md bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700"
            >
              {t('workbench.browser_annotation_count', { count: annotations.length })}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2">
          <BrowserToolbarButton
            testId="workspace-browser-back-button"
            label={t('workbench.browser_back')}
            disabled={!currentUrl || !embeddedBrowserAvailable}
            onClick={() => void runBrowserCommand(() => goBackEmbeddedBrowser(label))}
          >
            <ArrowLeft className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-forward-button"
            label={t('workbench.browser_forward')}
            disabled={!currentUrl || !embeddedBrowserAvailable}
            onClick={() => void runBrowserCommand(() => goForwardEmbeddedBrowser(label))}
          >
            <ArrowRight className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-reload-button"
            label={t('workbench.browser_reload')}
            disabled={!activePageUrl}
            onClick={handleReload}
          >
            <RotateCw className="h-4 w-4" />
          </BrowserToolbarButton>
          <form onSubmit={handleSubmit} className="min-w-0 flex-1">
            <input
              data-testid="workspace-browser-url-input"
              value={address}
              onChange={event => setAddress(event.target.value)}
              placeholder={t('workbench.browser_url_placeholder')}
              className="h-8 w-full rounded-md border border-border bg-surface px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:bg-background"
            />
          </form>
          <BrowserToolbarButton
            testId="workspace-browser-downloads-button"
            label={t('workbench.browser_downloads')}
            onClick={() => setDownloadsOpen(open => !open)}
          >
            <span className="relative">
              <Download className="h-4 w-4" />
              {downloads.some(
                download => download.status === 'started' || download.status === 'progress'
              ) ? (
                <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-primary" />
              ) : null}
            </span>
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-annotate-button"
            label={t('workbench.browser_annotation_start')}
            disabled={!activePageUrl || !embeddedBrowserAvailable || internalDesktopPage}
            onClick={() => void enterAnnotationMode()}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-open-external-button"
            label={t('workbench.browser_open_external')}
            disabled={!activePageUrl || internalDesktopPage}
            onClick={handleOpenExternal}
          >
            <ExternalLink className="h-4 w-4" />
          </BrowserToolbarButton>
        </div>
      )}
      {(!annotationMode || internalDesktopPage) && downloadsOpen ? (
        <div
          data-testid="workspace-browser-downloads-panel"
          className="flex max-h-40 shrink-0 flex-col overflow-y-auto border-b border-border bg-surface px-3 py-2"
        >
          {downloads.length === 0 ? (
            <span className="text-xs text-text-muted">
              {t('workbench.browser_downloads_empty')}
            </span>
          ) : (
            downloads.map(download => {
              const fileName = download.path?.split(/[\\/]/).pop() || download.url
              const downloading = download.status === 'started' || download.status === 'progress'
              const progress =
                download.totalBytes && download.receivedBytes !== null
                  ? Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100))
                  : null
              return (
                <div
                  key={download.id}
                  data-testid="workspace-browser-download-item"
                  className="flex min-h-12 flex-col justify-center gap-1 text-xs"
                >
                  <div className="flex items-center gap-2">
                    {download.status === 'finished' ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
                    ) : download.status === 'failed' ? (
                      <CircleAlert className="h-4 w-4 shrink-0 text-red-500" />
                    ) : download.status === 'paused' ? (
                      <Download className="h-4 w-4 shrink-0 text-text-muted" />
                    ) : (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={download.path ?? download.url}>
                      {fileName}
                    </span>
                    <span className="shrink-0 text-text-muted">
                      {downloading
                        ? progress !== null
                          ? `${progress}% · ${formatDownloadBytes(download.receivedBytes)} / ${formatDownloadBytes(download.totalBytes)}`
                          : formatDownloadBytes(download.receivedBytes) ||
                            t('workbench.browser_download_started')
                        : t(`workbench.browser_download_${download.status}`)}
                    </span>
                    {download.status === 'finished' && download.path ? (
                      <button
                        type="button"
                        data-testid="workspace-browser-download-reveal-button"
                        className="shrink-0 rounded-md px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary"
                        onClick={() => void revealLocalFile(download.path ?? undefined)}
                      >
                        {t('workbench.browser_download_reveal')}
                      </button>
                    ) : null}
                    {downloading ? (
                      <button
                        type="button"
                        data-testid="workspace-browser-download-pause-button"
                        className="shrink-0 rounded-md p-1 text-text-secondary hover:bg-muted hover:text-text-primary"
                        aria-label={t('workbench.browser_download_pause')}
                        onClick={() => void pauseEmbeddedBrowserDownload(download.id)}
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    {download.status === 'paused' ? (
                      <>
                        <button
                          type="button"
                          data-testid="workspace-browser-download-resume-button"
                          className="shrink-0 rounded-md p-1 text-text-secondary hover:bg-muted hover:text-text-primary"
                          aria-label={t('workbench.browser_download_resume')}
                          onClick={() => void resumeEmbeddedBrowserDownload(download.id)}
                        >
                          <Play className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid="workspace-browser-download-delete-button"
                          className="shrink-0 rounded-md p-1 text-red-500 hover:bg-red-500/10"
                          aria-label={t('workbench.browser_download_delete')}
                          onClick={() => void deleteEmbeddedBrowserDownload(download.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : null}
                  </div>
                  {downloading ? (
                    <div
                      data-testid="workspace-browser-download-progress"
                      className="ml-6 h-1 overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className={`h-full rounded-full bg-primary transition-[width] ${
                          progress === null ? 'w-1/3 animate-pulse' : ''
                        }`}
                        style={progress === null ? undefined : { width: `${progress}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background pl-1">
        {!currentUrl && (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <Globe2 className="mb-4 h-8 w-8 text-text-muted" />
            <p className="text-sm font-semibold text-text-primary">
              {t('workbench.browser_empty_title')}
            </p>
            <p className="mt-2 text-sm leading-[18px] text-text-secondary">
              {t('workbench.browser_empty_desc')}
            </p>
          </div>
        )}
        {currentUrl && !embeddedBrowserAvailable && (
          <iframe
            key={currentUrl}
            data-testid="workspace-browser-frame"
            title={t('workbench.browser')}
            src={currentUrl}
            className="h-full w-full border-0 bg-background"
          />
        )}
        {currentUrl && embeddedBrowserAvailable && (
          <div
            ref={browserHostRef}
            data-testid="workspace-browser-native-view"
            className="relative h-full min-h-0 w-full bg-background"
            aria-label={t('workbench.browser')}
          >
            {status === 'loading' && (
              <div
                data-testid="workspace-browser-loading"
                className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40"
              >
                <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
              </div>
            )}
          </div>
        )}
        {error && (
          <div
            data-testid="workspace-browser-error"
            role="alert"
            className="absolute inset-x-4 top-4 rounded-md border border-red-500/30 bg-background px-3 py-2 text-sm text-red-500 shadow-sm"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

function BrowserToolbarButton({
  children,
  disabled,
  label,
  onClick,
  testId,
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}
