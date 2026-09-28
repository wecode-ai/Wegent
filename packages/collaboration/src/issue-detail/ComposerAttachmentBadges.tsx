import {
  ChevronRight,
  File,
  FileText,
  Loader2,
  ScanText,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  canRestorePastedText,
  isPastedTextFile,
} from "../composer/pastedTextAttachment";
import {
  AttachmentImageView,
  type AttachmentImageServices,
  type ImageAttachment,
} from "./AttachmentImageView";
import {
  getAttachmentTextPreview,
  isImageAttachment,
  type ComposerAttachmentMetadata,
} from "./attachmentPresentation";

export interface ComposerAttachment
  extends ComposerAttachmentMetadata, ImageAttachment {
  id: string | number;
  text_content?: string | null;
  ui_group_role?: string;
  ui_kind?: string;
  text_length?: number | null;
}
export interface ComposerAttachmentBadgesProps<T extends ComposerAttachment> {
  attachments: T[];
  uploadingFiles: ReadonlyMap<
    string,
    { file: File; progress?: number; previewUrl?: string }
  >;
  errors: ReadonlyMap<string, string>;
  onRemoveAttachment(id: T["id"]): void;
  onOpenAttachment?(attachment: T): void;
  onShowTextAttachment?(attachment: T): void;
  imageServices: AttachmentImageServices<T>;
  labels: {
    showText: string;
    appshot: string;
    pastedText: string;
    addingText: string;
  };
  leading?: ReactNode;
}

const attachmentTileClassName =
  "group/attachment relative h-[122px] w-40 shrink-0";

function AttachmentTileBorder() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-border"
    />
  );
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
      className={`${attachmentTileClassName} flex items-center justify-center overflow-hidden rounded-2xl bg-muted`}
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
      <AttachmentTileBorder />
    </div>
  );
}

function RemoveAttachmentButton<Id extends string | number>({
  attachmentId,
  onRemoveAttachment,
  tile = false,
}: {
  attachmentId: Id;
  onRemoveAttachment: (attachmentId: Id) => void;
  tile?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid="remove-attachment-button"
      onClick={() => onRemoveAttachment(attachmentId)}
      className={`absolute flex h-6 w-6 items-center justify-center rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${tile ? "-right-1.5 -top-1.5 [@media(hover:hover)]:opacity-0 group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100 focus-visible:opacity-100" : "right-1 top-1"}`}
      aria-label="Remove attachment"
    >
      <X
        className={`h-4 w-4 rounded-full bg-text-primary p-0.5 text-background ${tile ? "ring-2 ring-background" : ""}`}
      />
    </button>
  );
}

function DocumentAttachmentCard({
  filename,
  uploading = false,
  progress,
  children,
  onOpen,
}: {
  filename: string;
  uploading?: boolean;
  progress?: number;
  children?: ReactNode;
  onOpen?: () => void;
}) {
  return (
    <div
      data-testid={
        uploading ? "uploading-attachment-badge" : "attachment-badge"
      }
      aria-busy={uploading || undefined}
      className={attachmentTileClassName}
    >
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-muted text-text-primary">
        <span
          data-testid="attachment-document-icon"
          className="flex h-[90px] shrink-0 items-center justify-center gap-2 text-text-secondary"
        >
          {uploading ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              {progress !== undefined && (
                <span className="text-xs">{progress}%</span>
              )}
            </>
          ) : (
            <File className="h-6 w-6" aria-hidden="true" strokeWidth={1.5} />
          )}
        </span>
        <span className="flex h-8 min-w-0 shrink-0 items-center gap-1 bg-background px-2 text-xs leading-4">
          <FileText
            className="h-4 w-4 shrink-0 text-focus"
            aria-hidden="true"
          />
          <span className="truncate" title={filename}>
            {filename}
          </span>
        </span>
      </div>
      <AttachmentTileBorder />
      {onOpen && (
        <button
          type="button"
          data-testid="attachment-document-preview-button"
          aria-label={filename}
          onClick={onOpen}
          className="absolute inset-0 cursor-pointer rounded-2xl hover:bg-text-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        />
      )}
      {children}
    </div>
  );
}

function TextAttachmentCard({
  preview,
  pending = false,
  onOpen,
  onShowText,
  labels,
  children,
}: {
  preview: string;
  pending?: boolean;
  onOpen?: () => void;
  onShowText?: () => void;
  labels: ComposerAttachmentBadgesProps<ComposerAttachment>["labels"];
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={pending ? "uploading-attachment-badge" : "attachment-badge"}
      aria-busy={pending || undefined}
      className="relative inline-flex w-fit max-w-64 shrink-0 items-center gap-2.5 rounded-lg border border-border bg-background p-3 pr-8 text-left"
    >
      <span
        data-testid="attachment-text-icon"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-text-secondary"
      >
        <ScanText className="h-6 w-6" strokeWidth={1.8} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          data-testid="attachment-text-preview"
          className="truncate text-sm font-medium leading-5 text-text-primary"
          title={preview}
        >
          {preview || labels.pastedText}
        </span>
        <span className="truncate text-sm leading-5 text-text-secondary">
          {pending ? (
            labels.addingText
          ) : onShowText ? (
            <button
              type="button"
              data-testid="show-text-attachment-button"
              className="relative z-10 inline-flex max-w-full items-center gap-1 underline underline-offset-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={onShowText}
            >
              <span className="truncate">{labels.showText}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            </button>
          ) : (
            labels.pastedText
          )}
        </span>
      </span>
      {onOpen && (
        <button
          type="button"
          data-testid="attachment-text-open-button"
          aria-label={preview || labels.pastedText}
          onClick={onOpen}
          className="absolute inset-0 cursor-pointer rounded-lg hover:bg-text-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        />
      )}
      {children}
    </div>
  );
}

function PendingTextAttachment({
  file,
  labels,
}: {
  file: File;
  labels: ComposerAttachmentBadgesProps<ComposerAttachment>["labels"];
}) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    let active = true;
    void file
      .slice(0, 512)
      .text()
      .then((text) => {
        if (active) setPreview(text.trim().split(/\r?\n/, 1)[0]);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [file]);
  return <TextAttachmentCard preview={preview} pending labels={labels} />;
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
  onOpenAttachment,
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
      className="mb-3 flex min-w-0 items-end gap-3 overflow-x-auto py-2 pr-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-testid="attachment-badge-list"
    >
      {leading}
      {visibleAttachments
        .filter((attachment) => attachment.ui_kind !== "pasted-text")
        .map((attachment) =>
          isImageAttachment(attachment) ? (
            <div
              key={attachment.id}
              data-testid="attachment-badge"
              className={attachmentTileClassName}
            >
              <AttachmentImageView
                services={imageServices}
                attachment={attachment}
                buttonTestId="attachment-image-preview-button"
                imageTestId="attachment-image-preview"
                loadingTestId="attachment-image-preview-loading"
                errorTestId="attachment-image-preview-error"
                imageClassName="h-full w-full rounded-2xl object-cover"
                placeholderClassName="flex h-full w-full items-center justify-center rounded-2xl bg-muted text-text-muted"
                buttonClassName="block h-full w-full cursor-zoom-in rounded-2xl p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              />
              <AttachmentTileBorder />
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
                tile
              />
            </div>
          ) : (
            <DocumentAttachmentCard
              key={attachment.id}
              filename={attachment.filename}
              onOpen={
                onOpenAttachment
                  ? () => onOpenAttachment(attachment)
                  : undefined
              }
            >
              <RemoveAttachmentButton
                attachmentId={attachment.id}
                onRemoveAttachment={onRemoveAttachment}
                tile
              />
            </DocumentAttachmentCard>
          ),
        )}
      {Array.from(uploadingFiles.entries())
        .filter(([, upload]) => !isPastedTextFile(upload.file))
        .map(([fileId, upload]) =>
          upload.file.type.toLowerCase().startsWith("image/") ||
          /\.(apng|avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(
            upload.file.name,
          ) ? (
            <PendingImageAttachment
              key={fileId}
              file={upload.file}
              previewUrl={upload.previewUrl}
            />
          ) : (
            <DocumentAttachmentCard
              key={fileId}
              filename={upload.file.name}
              uploading
              progress={upload.progress}
            />
          ),
        )}
      {visibleAttachments
        .filter((attachment) => attachment.ui_kind === "pasted-text")
        .map((attachment) => (
          <TextAttachmentCard
            key={attachment.id}
            preview={
              getAttachmentTextPreview(attachment) ?? attachment.filename
            }
            labels={labels}
            onOpen={
              onOpenAttachment ? () => onOpenAttachment(attachment) : undefined
            }
            onShowText={
              attachment.text_content &&
              onShowTextAttachment &&
              canRestorePastedText(
                attachment.text_length ?? attachment.text_content.length,
              )
                ? () => onShowTextAttachment(attachment)
                : undefined
            }
          >
            <RemoveAttachmentButton
              attachmentId={attachment.id}
              onRemoveAttachment={onRemoveAttachment}
            />
          </TextAttachmentCard>
        ))}
      {Array.from(uploadingFiles.entries())
        .filter(([, upload]) => isPastedTextFile(upload.file))
        .map(([fileId, upload]) => (
          <PendingTextAttachment
            key={fileId}
            file={upload.file}
            labels={labels}
          />
        ))}

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
