import { useMemo, useState, type ReactNode } from "react";
import {
  classifyMarkdownLink,
  getMarkdownAttachmentId,
} from "../markdown/assistantMarkdownLinks";
import { useIssueResources } from "./issueResourcesContext";
import {
  AssistantMarkdown,
  MarkdownServicesProvider,
  useMarkdownServices,
} from "../markdown";

export function IssueActivityMarkdown({
  content,
  isStreaming = false,
  onOpenAttachment,
  translate,
  variant,
}: {
  content: string;
  isStreaming?: boolean;
  onOpenAttachment?(id: string, filename: string): void | Promise<void>;
  translate?(key: string, fallback?: string): string;
  variant?: "document";
}) {
  const inherited = useMarkdownServices();
  const resources = useIssueResources();
  const services = useMemo(
    () => ({
      ...inherited,
      translate: translate ?? inherited.translate,
      openMarkdownImage:
        resources && (onOpenAttachment || resources.open)
          ? async (href: string, label?: string) => {
              const attachment = await resources.resolve(href, label);
              if (onOpenAttachment)
                await onOpenAttachment(attachment.id, attachment.display_name);
              else await resources.open?.(attachment);
            }
          : inherited.openMarkdownImage,
    }),
    [inherited, translate, resources, onOpenAttachment],
  );
  return (
    <MarkdownServicesProvider value={services}>
      <AssistantMarkdown
        content={content}
        isStreaming={isStreaming}
        variant={variant}
        preserveLineBreaks={!variant}
        renderLink={(href, text, children) => {
          const id = getMarkdownAttachmentId(href);
          if (
            !id &&
            !(
              resources &&
              (onOpenAttachment || resources.open) &&
              classifyMarkdownLink(href).kind === "file"
            )
          )
            return undefined;
          return (
            <IssueResourceLink
              href={href}
              label={text}
              attachmentId={id}
              onOpen={onOpenAttachment}
              children={children}
            />
          );
        }}
      />
    </MarkdownServicesProvider>
  );
}

function IssueResourceLink({
  href,
  label,
  attachmentId,
  onOpen,
  children,
}: {
  href: string;
  label: string;
  attachmentId: string | null;
  onOpen?: (id: string, filename: string) => void | Promise<void>;
  children?: ReactNode;
}) {
  const resources = useIssueResources();
  const services = useMarkdownServices();
  const { translate } = services;
  const contentServices = useMemo(
    () => ({ ...services, openMarkdownImage: undefined }),
    [services],
  );
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <span>
      <button
        type="button"
        className="task-detail-ai-run-open-task min-h-11 md:min-h-0"
        data-resource-name={label}
        data-testid={
          attachmentId
            ? `issue-comment-attachment-${attachmentId}`
            : "issue-comment-file-attachment"
        }
        disabled={!(onOpen || resources?.open) || opening}
        aria-busy={opening || undefined}
        onClick={async () => {
          setFailed(false);
          setOpening(true);
          try {
            if (resources) {
              const attachment = await resources.resolve(href, label);
              if (onOpen) await onOpen(attachment.id, attachment.display_name);
              else await resources.open?.(attachment);
            } else if (attachmentId)
              await onOpen?.(attachmentId, label || attachmentId);
          } catch {
            setFailed(true);
          } finally {
            setOpening(false);
          }
        }}
      >
        <MarkdownServicesProvider value={contentServices}>
          {children ?? label}
        </MarkdownServicesProvider>
      </button>
      {failed ? (
        <span role="alert">
          {translate(
            "todo.file_preview_failed",
            "Could not open the Issue attachment",
          )}
        </span>
      ) : null}
    </span>
  );
}
