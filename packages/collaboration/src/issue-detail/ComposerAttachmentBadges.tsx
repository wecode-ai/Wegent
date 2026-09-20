import { ChevronRight, FileText, Loader2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  AttachmentImageView,
  type AttachmentImageServices,
  type ImageAttachment,
} from "./AttachmentImageView";
import {
  getAttachmentTextPreview,
  getAttachmentTypeLabel,
  isImageAttachment,
  isTextAttachment,
  type ComposerAttachmentMetadata,
} from "./attachmentPresentation";

export interface ComposerAttachment
  extends ComposerAttachmentMetadata, ImageAttachment {
  id: string | number;
  text_content?: string | null;
  ui_group_role?: string;
  ui_kind?: string;
}
export interface ComposerAttachmentBadgesProps<T extends ComposerAttachment> {
  attachments: T[];
  uploadingFiles: ReadonlyMap<
    string,
    { file: File; progress?: number; previewUrl?: string }
  >;
  errors: ReadonlyMap<string, string>;
  onRemoveAttachment(id: T["id"]): void;
  onShowTextAttachment?(attachment: T): void;
  imageServices: AttachmentImageServices<T>;
  labels: { showText: string; appshot: string };
  leading?: ReactNode;
}

function PendingImageAttachment({
  file,
  previewUrl,
}: {
  file: File;
  previewUrl?: string;
}) {
  const [loaded, setLoaded] = useState<{ file: File; url: string } | null>(
    null,
  );
  useEffect(() => {
    if (previewUrl) return;
    const url = URL.createObjectURL(file);
    setLoaded({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file, previewUrl]);
  const src = previewUrl ?? (loaded?.file === file ? loaded.url : undefined);
  return (
    <div
      data-testid="pending-image-attachment"
      className="h-20 w-20 shrink-0 overflow-hidden rounded-xl"
    >
      {src ? (
        <img
          data-testid="pending-image-attachment-preview"
          src={src}
          alt={file.name}
          className="h-full w-full object-cover"
        />
      ) : (
        <Loader2 className="h-5 w-5 animate-spin" />
      )}
    </div>
  );
}

function RemoveAttachmentButton<Id extends string | number>({
  attachmentId,
  onRemoveAttachment,
}: {
  attachmentId: Id;
  onRemoveAttachment: (attachmentId: Id) => void;
}) {
  return (
    <button
      type="button"
      data-testid="remove-attachment-button"
      onClick={() => onRemoveAttachment(attachmentId)}
      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-text-primary text-background shadow-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      aria-label="Remove attachment"
    >
      <X className="h-3 w-3" />
    </button>
  );
}

function DocumentAttachmentCard<T extends ComposerAttachment>({
  attachment,
  onRemoveAttachment,
}: {
  attachment: T;
  onRemoveAttachment: (attachmentId: T["id"]) => void;
}) {
  const typeLabel = getAttachmentTypeLabel(attachment);

  return (
    <div
      data-testid="attachment-badge"
      className="relative inline-flex h-14 w-[220px] items-center gap-3 rounded-xl border border-border bg-background px-3 pr-8 text-xs text-text-secondary shadow-sm"
    >
      <span
        data-testid="attachment-document-icon"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-xs font-semibold leading-none text-red-600"
      >
        {typeLabel}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-text-primary">
          {attachment.filename}
        </span>
        <span className="truncate text-text-secondary">{typeLabel}</span>
      </span>
      <RemoveAttachmentButton
        attachmentId={attachment.id}
        onRemoveAttachment={onRemoveAttachment}
      />
    </div>
  );
}

function TextAttachmentCard<T extends ComposerAttachment>({
  attachment,
  onRemoveAttachment,
  onShowTextAttachment,
  showTextLabel,
}: {
  attachment: T;
  onRemoveAttachment: (attachmentId: T["id"]) => void;
  onShowTextAttachment?: (attachment: T) => void;
  showTextLabel: string;
}) {
  const preview = getAttachmentTextPreview(attachment) ?? attachment.filename;
  const canShowInTextbox = Boolean(
    attachment.text_content && onShowTextAttachment,
  );

  return (
    <div
      data-testid="attachment-badge"
      className="relative inline-flex h-[72px] max-w-[min(420px,100%)] items-center gap-3 rounded-[20px] border border-border bg-muted px-3 pr-8 text-left shadow-sm"
    >
      <span
        data-testid="attachment-text-icon"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-text-primary text-background"
      >
        <FileText className="h-5 w-5" strokeWidth={1.8} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          data-testid="attachment-text-preview"
          className="truncate text-sm font-semibold leading-5 text-text-primary"
          title={preview}
        >
          {preview}
        </span>
        {canShowInTextbox ? (
          <button
            type="button"
            data-testid="show-text-attachment-button"
            className="inline-flex w-fit max-w-full items-center gap-1 truncate text-sm leading-5 text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            onClick={() => onShowTextAttachment?.(attachment)}
          >
            <span className="truncate">{showTextLabel}</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          </button>
        ) : (
          <span className="truncate text-sm leading-5 text-text-secondary">
            {getAttachmentTypeLabel(attachment)}
          </span>
        )}
      </span>
      <RemoveAttachmentButton
        attachmentId={attachment.id}
        onRemoveAttachment={onRemoveAttachment}
      />
    </div>
  );
}

export function ComposerAttachmentBadges<T extends ComposerAttachment>({
  imageServices,
  labels,
  leading,
  attachments,
  uploadingFiles,
  errors,
  onRemoveAttachment,
  onShowTextAttachment,
}: ComposerAttachmentBadgesProps<T>) {
  const visibleAttachments = attachments.filter(
    (attachment) => attachment.ui_group_role !== "companion",
  );
  if (
    attachments.length === 0 &&
    uploadingFiles.size === 0 &&
    errors.size === 0 &&
    !leading
  ) {
    return null;
  }

  return (
    <div
      className="mb-3 flex flex-wrap gap-2"
      data-testid="attachment-badge-list"
    >
      {leading}
      {visibleAttachments.map((attachment) =>
        isImageAttachment(attachment) ? (
          <div
            key={attachment.id}
            data-testid="attachment-badge"
            className="relative h-20 w-20 shrink-0"
          >
            <AttachmentImageView
              services={imageServices}
              attachment={attachment}
              buttonTestId="attachment-image-preview-button"
              imageTestId="attachment-image-preview"
              loadingTestId="attachment-image-preview-loading"
              errorTestId="attachment-image-preview-error"
              imageClassName="h-full w-full rounded-xl object-cover"
              placeholderClassName="flex h-full w-full items-center justify-center rounded-xl border border-border bg-surface text-text-muted"
              buttonClassName="block h-full w-full cursor-zoom-in p-0 text-left"
            />
            {attachment.ui_kind === "appshot" && (
              <span
                data-testid="attachment-appshot-label"
                className="pointer-events-none absolute bottom-1 left-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white"
              >
                {labels.appshot}
              </span>
            )}
            <RemoveAttachmentButton
              attachmentId={attachment.id}
              onRemoveAttachment={onRemoveAttachment}
            />
          </div>
        ) : isTextAttachment(attachment) ? (
          <TextAttachmentCard
            key={attachment.id}
            attachment={attachment}
            onRemoveAttachment={onRemoveAttachment}
            onShowTextAttachment={onShowTextAttachment}
            showTextLabel={labels.showText}
          />
        ) : (
          <DocumentAttachmentCard
            key={attachment.id}
            attachment={attachment}
            onRemoveAttachment={onRemoveAttachment}
          />
        ),
      )}
      {Array.from(uploadingFiles.entries()).map(([fileId, upload]) =>
        upload.file.type.toLowerCase().startsWith("image/") ||
        /\.(apng|avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(upload.file.name) ? (
          <PendingImageAttachment
            key={fileId}
            file={upload.file}
            previewUrl={upload.previewUrl}
          />
        ) : (
          <span
            key={fileId}
            data-testid="uploading-attachment-badge"
            className="inline-flex max-w-[220px] items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span className="min-w-0 truncate">{upload.file.name}</span>
            {upload.progress !== undefined ? (
              <span className="shrink-0 text-text-muted">
                {upload.progress}%
              </span>
            ) : null}
          </span>
        ),
      )}
      {Array.from(errors.entries()).map(([fileId, error]) => (
        <span
          key={fileId}
          data-testid="attachment-error-badge"
          className="inline-flex max-w-[260px] items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700"
        >
          <FileText className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">{fileId}</span>
          <span className="min-w-0 truncate">{error}</span>
        </span>
      ))}
    </div>
  );
}
