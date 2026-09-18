import { useMemo, type ReactNode } from "react";
import { useDocumentTheme } from "../theme";
import { browserMarkdownServices, MarkdownServicesProvider } from "../markdown";
import type { SharedWorkspaceAttachmentsApi } from "../ports/SharedWorkspaceApi";

/** Bind authenticated cloud attachments and the Web theme to the shared renderer. */
export function IssueMarkdownProvider({
  attachments,
  children,
}: {
  attachments?: SharedWorkspaceAttachmentsApi;
  children: ReactNode;
}) {
  const theme = useDocumentTheme();
  const services = useMemo(
    () => ({
      ...browserMarkdownServices,
      theme,
      fetchAttachmentBlob: attachments
        ? (id: number) => attachments.read(String(id))
        : undefined,
    }),
    [attachments, theme],
  );
  return (
    <MarkdownServicesProvider value={services}>
      {children}
    </MarkdownServicesProvider>
  );
}
