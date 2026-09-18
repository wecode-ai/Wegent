import { useCollaborationPortalTheme } from "../theme";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Minus,
  Plus,
  X,
} from "lucide-react";
export interface ImageAttachment {
  filename: string;
  image_width?: number | null;
  image_height?: number | null;
}

export interface AttachmentImageServices<T extends ImageAttachment> {
  identity(attachment: T): string;
  load(attachment: T): Promise<{ url: string; release: (() => void) | null }>;
  download(attachment: T, url: string, filename: string): Promise<void>;
  localPath?(attachment: T): string | null;
  onError?(attachment: T): void;
  loadImmediately?: boolean;
}

export interface AttachmentImageViewProps<T extends ImageAttachment> {
  services: AttachmentImageServices<T>;
  attachment: T;
  buttonTestId: string;
  imageTestId: string;
  loadingTestId: string;
  errorTestId: string;
  imageClassName: string;
  placeholderClassName: string;
  buttonClassName?: string;
  disableLightbox?: boolean;
  galleryAttachments?: T[];
  galleryIndex?: number;
  resolveDownloadFilename?: (attachment: T, index: number) => string;
  hideOnError?: boolean;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, value));
}

function attachmentAspectRatio(
  attachment: ImageAttachment,
): number | undefined {
  const width = attachment.image_width;
  const height = attachment.image_height;
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return undefined;
  }
  return width / height;
}

export function AttachmentImageView<T extends ImageAttachment>({
  services,
  attachment,
  buttonTestId,
  imageTestId,
  loadingTestId,
  errorTestId,
  imageClassName,
  placeholderClassName,
  buttonClassName = "block max-w-full cursor-zoom-in p-0 text-left",
  disableLightbox = false,
  galleryAttachments,
  galleryIndex = 0,
  resolveDownloadFilename,
  hideOnError = false,
}: AttachmentImageViewProps<T>) {
  const portalTheme = useCollaborationPortalTheme();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(galleryIndex);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [isLightboxLoading, setIsLightboxLoading] = useState(false);
  const [hasLightboxError, setHasLightboxError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const loadsPreviewImmediately =
    services.loadImmediately || typeof IntersectionObserver === "undefined";
  const [shouldLoadPreview, setShouldLoadPreview] = useState(
    loadsPreviewImmediately,
  );
  const previewContainerRef = useRef<HTMLElement | null>(null);
  const previewUrlRef = useRef(previewUrl);
  const lightboxUrlRef = useRef(lightboxUrl);
  const previewIdentity = services.identity(attachment);
  const previewAspectRatio = attachmentAspectRatio(attachment);
  const previewContainerStyle =
    previewAspectRatio === undefined
      ? undefined
      : { aspectRatio: previewAspectRatio };
  const attachmentRef = useRef(attachment);
  const setPreviewContainerRef = useCallback((element: HTMLElement | null) => {
    previewContainerRef.current = element;
  }, []);
  useEffect(() => {
    attachmentRef.current = attachment;
  }, [attachment]);
  useLayoutEffect(() => {
    previewUrlRef.current = previewUrl;
    lightboxUrlRef.current = lightboxUrl;
  }, [lightboxUrl, previewUrl]);
  const gallery = useMemo(
    () => (galleryAttachments?.length ? galleryAttachments : [attachment]),
    [attachment, galleryAttachments],
  );
  const currentLightboxIndex = clampIndex(lightboxIndex, gallery.length);
  const currentLightboxAttachment = gallery[currentLightboxIndex] ?? attachment;
  const canNavigateLightbox = gallery.length > 1;
  const previewLocalPath = services.localPath?.(attachment);
  const lightboxLocalPath = services.localPath?.(currentLightboxAttachment);

  /* eslint-disable react-hooks/set-state-in-effect -- Attachment identity changes must clear stale preview UI before loading the next image. */
  useEffect(() => {
    setShouldLoadPreview(loadsPreviewImmediately);
    setPreviewUrl(null);
    setHasError(false);
    setIsLightboxOpen(false);
    setLightboxUrl(null);
    setZoom(1);
  }, [loadsPreviewImmediately, previewIdentity]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (shouldLoadPreview) return undefined;

    const element = previewContainerRef.current;
    if (!element) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some(
            (entry) => entry.isIntersecting || entry.intersectionRatio > 0,
          )
        ) {
          setShouldLoadPreview(true);
          observer.disconnect();
        }
      },
      { root: null, rootMargin: "320px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [previewIdentity, shouldLoadPreview]);

  useEffect(() => {
    if (!shouldLoadPreview) return undefined;

    let isMounted = true;
    let releasePreview: (() => void) | null = null;
    const targetAttachment = attachmentRef.current;

    async function loadPreview() {
      setPreviewUrl(null);
      setHasError(false);
      setIsLightboxOpen(false);
      setLightboxUrl(null);
      setZoom(1);

      try {
        const loaded = await services.load(targetAttachment);
        releasePreview = loaded.release;
        if (isMounted) {
          setPreviewUrl(loaded.url);
        } else {
          releasePreview?.();
        }
      } catch {
        if (isMounted) {
          services.onError?.(targetAttachment);
          setHasError(true);
        }
      }
    }

    void loadPreview();

    return () => {
      isMounted = false;
      releasePreview?.();
    };
  }, [services, previewIdentity, shouldLoadPreview]);

  useEffect(() => {
    if (!isLightboxOpen || disableLightbox) return;

    let isMounted = true;
    let releaseLightboxPreview: (() => void) | null = null;
    const nextIndex = clampIndex(lightboxIndex, gallery.length);
    const currentAttachment = attachmentRef.current;
    const selectedAttachment = gallery[nextIndex] ?? currentAttachment;
    const reusablePreviewUrl =
      services.identity(selectedAttachment) ===
      services.identity(currentAttachment)
        ? previewUrl
        : null;

    async function loadLightboxImage() {
      setZoom(1);
      setHasLightboxError(false);

      if (reusablePreviewUrl) {
        setIsLightboxLoading(false);
        setLightboxUrl(reusablePreviewUrl);
        return;
      }

      setIsLightboxLoading(true);
      setLightboxUrl(null);

      try {
        const loaded = await services.load(selectedAttachment);
        releaseLightboxPreview = loaded.release;
        if (isMounted) {
          setLightboxUrl(loaded.url);
          setIsLightboxLoading(false);
        } else {
          releaseLightboxPreview?.();
        }
      } catch {
        if (isMounted) {
          services.onError?.(selectedAttachment);
          setIsLightboxLoading(false);
          setHasLightboxError(true);
        }
      }
    }

    void loadLightboxImage();

    return () => {
      isMounted = false;
      releaseLightboxPreview?.();
    };
  }, [
    disableLightbox,
    services,
    gallery,
    isLightboxOpen,
    lightboxIndex,
    previewIdentity,
    previewUrl,
  ]);

  useEffect(() => {
    if (!isLightboxOpen || disableLightbox) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsLightboxOpen(false);
        return;
      }

      if (event.key === "ArrowLeft" && canNavigateLightbox) {
        event.preventDefault();
        setLightboxIndex((current) =>
          current <= 0 ? gallery.length - 1 : current - 1,
        );
        return;
      }

      if (event.key === "ArrowRight" && canNavigateLightbox) {
        event.preventDefault();
        setLightboxIndex((current) =>
          current >= gallery.length - 1 ? 0 : current + 1,
        );
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canNavigateLightbox, disableLightbox, gallery.length, isLightboxOpen]);

  const openLightbox = () => {
    setLightboxIndex(clampIndex(galleryIndex, gallery.length));
    setLightboxUrl(null);
    setHasLightboxError(false);
    setIsLightboxOpen(true);
  };

  const goToPreviousImage = () => {
    setLightboxIndex((current) =>
      current <= 0 ? gallery.length - 1 : current - 1,
    );
  };

  const goToNextImage = () => {
    setLightboxIndex((current) =>
      current >= gallery.length - 1 ? 0 : current + 1,
    );
  };

  const handlePreviewError = (event: SyntheticEvent<HTMLImageElement>) => {
    const failedUrl = event.currentTarget.currentSrc || event.currentTarget.src;
    if (!(previewUrlRef.current && failedUrl === previewUrlRef.current)) return;
    services.onError?.(attachment);
    setPreviewUrl(null);
    setHasError(true);
  };

  const handleLightboxError = (event: SyntheticEvent<HTMLImageElement>) => {
    const failedUrl = event.currentTarget.currentSrc || event.currentTarget.src;
    if (!(lightboxUrlRef.current && failedUrl === lightboxUrlRef.current))
      return;
    setLightboxUrl(null);
    setHasLightboxError(true);
  };

  if (previewUrl) {
    const lightbox =
      !disableLightbox && isLightboxOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              {...portalTheme}
              data-testid="attachment-image-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={currentLightboxAttachment.filename}
              className={`${portalTheme.className} fixed inset-0 z-modal flex h-dvh w-dvw items-center justify-center overflow-hidden bg-black/90 p-0`}
              onClick={() => setIsLightboxOpen(false)}
              onWheel={(event) => {
                event.stopPropagation();
                setZoom((current) =>
                  clampZoom(
                    current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP),
                  ),
                );
              }}
            >
              <div className="absolute right-4 top-4 z-20 flex items-center gap-2.5">
                <button
                  type="button"
                  data-testid="attachment-image-download"
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (lightboxUrl) {
                      void services.download(
                        currentLightboxAttachment,
                        lightboxUrl,
                        resolveDownloadFilename?.(
                          currentLightboxAttachment,
                          currentLightboxIndex,
                        ) ?? currentLightboxAttachment.filename,
                      );
                    }
                  }}
                  disabled={!lightboxUrl}
                  aria-label="Download image"
                >
                  <Download className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  data-testid="attachment-image-lightbox-close"
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  onClick={(event) => {
                    event.stopPropagation();
                    setIsLightboxOpen(false);
                  }}
                  aria-label="Close image preview"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              {canNavigateLightbox && (
                <>
                  <button
                    type="button"
                    data-testid="attachment-image-previous"
                    className="absolute left-5 top-1/2 z-20 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    onClick={(event) => {
                      event.stopPropagation();
                      goToPreviousImage();
                    }}
                    aria-label="Previous image"
                  >
                    <ChevronLeft className="h-7 w-7" />
                  </button>
                  <button
                    type="button"
                    data-testid="attachment-image-next"
                    className="absolute right-5 top-1/2 z-20 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    onClick={(event) => {
                      event.stopPropagation();
                      goToNextImage();
                    }}
                    aria-label="Next image"
                  >
                    <ChevronRight className="h-7 w-7" />
                  </button>
                </>
              )}
              <div
                data-testid="attachment-image-zoom-controls"
                className="absolute bottom-6 left-1/2 z-20 flex h-11 -translate-x-1/2 items-center gap-2.5 rounded-full bg-white/15 px-1.5 text-white shadow-[0_12px_36px_rgba(0,0,0,0.35)]"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  data-testid="attachment-image-zoom-out"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() =>
                    setZoom((current) => clampZoom(current - ZOOM_STEP))
                  }
                  disabled={zoom <= MIN_ZOOM}
                  aria-label="Zoom out"
                >
                  <Minus className="h-[18px] w-[18px]" />
                </button>
                <span
                  data-testid="attachment-image-zoom-value"
                  className="min-w-14 select-none text-center text-base font-medium tabular-nums text-white"
                >
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type="button"
                  data-testid="attachment-image-zoom-in"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() =>
                    setZoom((current) => clampZoom(current + ZOOM_STEP))
                  }
                  disabled={zoom >= MAX_ZOOM}
                  aria-label="Zoom in"
                >
                  <Plus className="h-[18px] w-[18px]" />
                </button>
              </div>
              {lightboxUrl ? (
                <img
                  data-testid="attachment-image-lightbox-image"
                  src={lightboxUrl}
                  alt={currentLightboxAttachment.filename}
                  data-context-image-filename={
                    currentLightboxAttachment.filename
                  }
                  data-context-image-local-path={lightboxLocalPath ?? undefined}
                  className="max-h-[calc(100dvh-9rem)] max-w-[calc(100dvw-8rem)] rounded-2xl object-contain transition-transform duration-150 ease-out"
                  style={{ transform: `scale(${zoom})` }}
                  onClick={(event) => event.stopPropagation()}
                  onError={handleLightboxError}
                />
              ) : (
                <div
                  data-testid={
                    hasLightboxError
                      ? "attachment-image-lightbox-error"
                      : "attachment-image-lightbox-loading"
                  }
                  className="flex h-36 w-36 items-center justify-center rounded-2xl bg-white/10 text-white"
                  onClick={(event) => event.stopPropagation()}
                >
                  {isLightboxLoading ? (
                    <Loader2 className="h-7 w-7 animate-spin" />
                  ) : (
                    <FileText className="h-7 w-7" />
                  )}
                </div>
              )}
            </div>,
            document.body,
          )
        : null;

    if (disableLightbox) {
      return (
        <div
          ref={setPreviewContainerRef}
          data-testid={buttonTestId}
          className={buttonClassName}
          style={previewContainerStyle}
          aria-label={attachment.filename}
        >
          <img
            data-testid={imageTestId}
            src={previewUrl}
            alt={attachment.filename}
            data-context-image-filename={attachment.filename}
            data-context-image-local-path={previewLocalPath ?? undefined}
            loading="lazy"
            className={imageClassName}
            onError={handlePreviewError}
          />
        </div>
      );
    }

    return (
      <>
        <button
          ref={setPreviewContainerRef}
          type="button"
          data-testid={buttonTestId}
          className={buttonClassName}
          style={previewContainerStyle}
          onClick={openLightbox}
          aria-label={attachment.filename}
        >
          <img
            data-testid={imageTestId}
            src={previewUrl}
            alt={attachment.filename}
            data-context-image-filename={attachment.filename}
            data-context-image-local-path={previewLocalPath ?? undefined}
            loading="lazy"
            className={imageClassName}
            onError={handlePreviewError}
          />
        </button>
        {lightbox}
      </>
    );
  }

  if (hasError && hideOnError) {
    return null;
  }

  return (
    <div
      ref={setPreviewContainerRef}
      data-testid={hasError ? errorTestId : loadingTestId}
      className={placeholderClassName}
      style={previewContainerStyle}
      aria-label={attachment.filename}
    >
      {hasError ? (
        <FileText className="h-5 w-5" />
      ) : (
        <Loader2 className="h-5 w-5 animate-spin" />
      )}
    </div>
  );
}
