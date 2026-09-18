import {
  normalizedFileExtension,
  readTextAttachmentMetadata,
} from "./attachmentPresentation";
import type { ComposerAttachment } from "./ComposerAttachmentBadges";
import { useEffect, useRef, useState } from "react";
import type { CollaborationAttachment } from "../types";
import type { IssueReplyAttachments } from "./IssueThreadReplyComposer";

export type IssueCommentAttachment = CollaborationAttachment &
  ComposerAttachment & { sourceFile: File };

/** Keep files separate from the draft until the comment is successfully sent. */
export function useIssueCommentAttachments(
  upload: ((file: File) => Promise<CollaborationAttachment>) | undefined,
  remove: ((id: string) => Promise<void>) | undefined,
): IssueReplyAttachments<IssueCommentAttachment> {
  const [attachments, setAttachments] = useState<IssueCommentAttachment[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(
    new Map<string, { file: File }>(),
  );
  const [errors, setErrors] = useState(new Map<string, string>());
  const active = useRef(true);
  const nextId = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return {
    attachments,
    uploadingFiles,
    errors,
    isAttachmentReadyToSend: uploadingFiles.size === 0,
    async handleFileSelect(files) {
      if (!upload) throw new Error("Issue attachment upload is unavailable");
      // Register the complete batch before starting any upload.
      const pending = files.map((file) => ({
        file,
        key: `${++nextId.current}:${file.name}`,
      }));
      setUploadingFiles(
        (current) =>
          new Map([
            ...current,
            ...pending.map(({ key, file }) => [key, { file }] as const),
          ]),
      );
      for (const { file, key } of pending) {
        try {
          const attachment = await upload(file);
          const textMetadata = await readTextAttachmentMetadata(file);
          if (active.current)
            setAttachments((current) => [
              ...current,
              {
                ...attachment,
                filename: attachment.display_name,
                sourceFile: file,
                mime_type:
                  attachment.content_type ||
                  file.type ||
                  "application/octet-stream",
                file_extension: normalizedFileExtension(file.name),
                ...textMetadata,
              },
            ]);
        } catch (cause) {
          if (active.current)
            setErrors((current) =>
              new Map(current).set(
                key,
                cause instanceof Error ? cause.message : String(cause),
              ),
            );
        } finally {
          if (active.current)
            setUploadingFiles((current) => {
              const next = new Map(current);
              next.delete(key);
              return next;
            });
        }
      }
    },
    async removeAttachment(id) {
      if (!remove) throw new Error("Issue attachment removal is unavailable");
      try {
        await remove(id);
        if (active.current) {
          setAttachments((current) =>
            current.filter((attachment) => attachment.id !== id),
          );
          setErrors((current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          });
        }
      } catch (cause) {
        if (active.current)
          setErrors((current) =>
            new Map(current).set(
              id,
              cause instanceof Error ? cause.message : String(cause),
            ),
          );
      }
    },
    resetAttachments() {
      setAttachments([]);
      setErrors(new Map());
    },
  };
}

export function issueCommentBody(
  text: string,
  attachments: CollaborationAttachment[],
) {
  return [
    text,
    ...attachments.map(
      (attachment) =>
        attachment.markdown ??
        `[${attachment.display_name.replace(/\]/g, "\\]")}](${attachment.markdown_url})`,
    ),
  ].join("\n\n");
}
