import { useMemo } from "react";
import {
  AssistantMarkdown,
  MarkdownServicesProvider,
  useMarkdownServices,
} from "../markdown";

/** Both hosts use the desktop renderer; adapters only supply platform operations. */
export function IssueActivityMarkdown({
  content,
  isStreaming = false,
  onOpenAttachment,
  translate,
}: {
  content: string;
  isStreaming?: boolean;
  onOpenAttachment?(id: string, filename: string): void;
  translate?(key: string, fallback?: string): string;
}) {
  const inherited = useMarkdownServices();
  const services = useMemo(
    () => (translate ? { ...inherited, translate } : inherited),
    [inherited, translate],
  );
  return (
    <MarkdownServicesProvider value={services}>
      <AssistantMarkdown
        content={content}
        isStreaming={isStreaming}
        renderLink={(href, text) => {
          const attachmentId = href.match(
            /^wegent:\/\/attachments\/([A-Za-z0-9_-]+)$/,
          )?.[1];
          if (!attachmentId) return undefined;
          return (
            <button
              type="button"
              className="task-detail-ai-run-open-task"
              data-testid={`issue-comment-attachment-${attachmentId}`}
              disabled={!onOpenAttachment}
              onClick={() =>
                onOpenAttachment?.(attachmentId, text || attachmentId)
              }
            >
              {text}
            </button>
          );
        }}
      />
    </MarkdownServicesProvider>
  );
}
