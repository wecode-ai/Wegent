import { useMemo, type ReactNode } from "react";
import { useDocumentTheme } from "../theme";
import { MarkdownServicesProvider, useMarkdownServices } from "../markdown";
import type { SharedWorkspaceAttachmentsApi } from "../ports/SharedWorkspaceApi";
import { createIssueResources } from "./issueResources";
import { IssueResourcesContext } from "./issueResourcesContext";
import type { CollaborationAttachment } from "../types";

/** Bind Issue resource ownership to Markdown without changing the host's other operations. */
export function IssueMarkdownProvider({
  attachments,
  issueId,
  projectId,
  children,
  onOpenAttachment,
}: {
  attachments?: SharedWorkspaceAttachmentsApi;
  issueId?: string;
  projectId?: string;
  children: ReactNode;
  onOpenAttachment?(attachment: CollaborationAttachment): void | Promise<void>;
}) {
  const theme = useDocumentTheme();
  const inherited = useMarkdownServices();
  const resources = useMemo(
    () =>
      attachments && issueId
        ? {
            ...createIssueResources(attachments, issueId, projectId),
            open: onOpenAttachment,
          }
        : undefined,
    [attachments, issueId, projectId, onOpenAttachment],
  );
  const services = useMemo(
    () => ({
      ...inherited,
      theme,
      fetchAttachmentBlob: attachments
        ? (id: number) => attachments.read(String(id))
        : inherited.fetchAttachmentBlob,
      readMarkdownImage: resources
        ? async (src: string, alt?: string) => {
            const { blob } = await resources.read(src, alt);
            if (!blob.type.startsWith("image/"))
              throw new Error("Issue attachment is not an image");
            return blob;
          }
        : inherited.readMarkdownImage,
    }),
    [attachments, inherited, resources, theme],
  );
  return (
    <MarkdownServicesProvider value={services}>
      <IssueResourcesContext.Provider value={resources}>
        {children}
      </IssueResourcesContext.Provider>
    </MarkdownServicesProvider>
  );
}
