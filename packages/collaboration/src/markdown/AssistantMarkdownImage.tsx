import { useEffect, useState } from "react";
import { useMarkdownServices } from "./MarkdownServices";
import {
  getAuthenticatedAttachmentId,
  isAuthenticatedAttachmentImageSrc,
  localMarkdownImagePath,
  resolveDirectMarkdownImageSrc,
} from "./assistantMarkdownLinks";
export function AssistantMarkdownImage({
  src,
  alt,
}: {
  src?: string | Blob;
  alt?: string;
}) {
  const { fetchAttachmentBlob, readLocalFile } = useMarkdownServices();
  const rawSrc = typeof src === "string" ? src.trim() : "";
  const [loadedPreview, setLoadedPreview] = useState<{
    rawSrc: string;
    url: string;
  } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const isAuthenticatedSrc = rawSrc
    ? isAuthenticatedAttachmentImageSrc(rawSrc)
    : false;
  const localPath = rawSrc ? localMarkdownImagePath(rawSrc) : null;
  const requiresBlobPreview =
    isAuthenticatedSrc || Boolean(localPath && readLocalFile);
  const resolvedSrc = requiresBlobPreview
    ? loadedPreview?.rawSrc === rawSrc
      ? loadedPreview.url
      : null
    : rawSrc
      ? resolveDirectMarkdownImageSrc(rawSrc)
      : null;
  const hasError = failedSrc === rawSrc;

  useEffect(() => {
    let objectUrl: string | null = null;
    let isMounted = true;

    if (!rawSrc || !requiresBlobPreview) {
      return () => {
        isMounted = false;
      };
    }

    async function loadImage() {
      try {
        let blob: Blob;
        if (isAuthenticatedSrc) {
          const attachmentId = getAuthenticatedAttachmentId(rawSrc);
          if (attachmentId === null) {
            throw new Error("Failed to resolve markdown attachment");
          }
          if (!fetchAttachmentBlob)
            throw new Error("Attachment download is unavailable");
          blob = await fetchAttachmentBlob(attachmentId);
          if (!blob.type.startsWith("image/")) {
            throw new Error(
              `Markdown image response is not an image: ${blob.type || "unknown"}`,
            );
          }
        } else if (localPath && readLocalFile) {
          blob = await readLocalFile(localPath);
        } else {
          throw new Error("Failed to resolve local markdown image");
        }

        objectUrl = URL.createObjectURL(blob);
        if (isMounted) {
          setLoadedPreview({ rawSrc, url: objectUrl });
        } else {
          URL.revokeObjectURL(objectUrl);
        }
      } catch {
        if (isMounted) {
          setFailedSrc(rawSrc);
        }
      }
    }

    void loadImage();

    return () => {
      isMounted = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [
    fetchAttachmentBlob,
    readLocalFile,
    isAuthenticatedSrc,
    localPath,
    rawSrc,
    requiresBlobPreview,
  ]);

  if (hasError) {
    return (
      <span
        data-testid="assistant-markdown-image-error"
        className="my-2 inline-flex max-w-full rounded-xl border border-border bg-surface px-3 py-2 text-xs text-text-muted"
      >
        {alt || rawSrc}
      </span>
    );
  }

  if (!resolvedSrc) {
    return (
      <span
        data-testid="assistant-markdown-image-loading"
        className="my-2 inline-flex h-20 w-32 max-w-full items-center justify-center rounded-xl border border-border bg-surface text-xs text-text-muted"
      >
        {alt || "Image"}
      </span>
    );
  }

  return (
    <img
      data-testid="assistant-markdown-image"
      data-scroll-anchor
      src={resolvedSrc}
      alt={alt || ""}
      className="my-2 block max-h-[360px] max-w-full rounded-xl border border-border bg-base object-contain"
      loading="lazy"
    />
  );
}
