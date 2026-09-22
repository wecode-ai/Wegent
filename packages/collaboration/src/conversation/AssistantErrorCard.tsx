import { useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import type { WorkbenchMessage } from "@wegent/chat-core/runtime-conversation";
import { parseChatError } from "@wegent/chat-core/chat-error";
import { useConversationTranslation } from "./ConversationTranslation";
import { useReaderDisclosure } from "./ReaderDisclosure";

export function AssistantErrorCard({
  error,
  errorType,
  rawError,
  message,
  onRetry,
  onSwitchModel,
}: {
  error?: string;
  errorType?: string;
  rawError?: string;
  message: WorkbenchMessage;
  onRetry?: (message: WorkbenchMessage) => void;
  onSwitchModel?: (message: WorkbenchMessage) => void;
}) {
  const { t } = useConversationTranslation();
  const reportReaderDisclosure = useReaderDisclosure();
  const [isDetailExpanded, setIsDetailExpanded] = useState(false);
  const displayError = rawError || error;
  const hasErrorDetails = Boolean(displayError);
  const parsedError = parseChatError(displayError ?? "", errorType);
  const modelName =
    displayError?.match(/model_id:\s*([^"'}\s]+)/)?.[1] ??
    displayError?.match(/model(?:\s+|_id["':\s]+)([a-z0-9._:-]+)/i)?.[1];
  const title = t(parsedError.titleKey);
  const description =
    parsedError.type === "model_protocol_error" && modelName
      ? t("assistant_error.types.model_protocol_error.description_with_model", {
          model: modelName,
        })
      : parsedError.type === "model_service_connection_error" &&
          parsedError.endpoint
        ? t(
            "assistant_error.types.model_service_connection_error.description_with_endpoint",
            {
              endpoint: parsedError.endpoint,
            },
          )
        : !hasErrorDetails && parsedError.type === "generic_error"
          ? t("assistant_error.types.generic_error.description_without_details")
          : t(parsedError.descriptionKey);

  return (
    <div
      data-testid="assistant-error-card"
      className="mt-2 flex w-[min(546px,100%)] max-w-full items-start gap-2.5 rounded-[14px] border border-border bg-surface px-3.5 py-3 text-text-primary"
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-base text-red-500 shadow-[inset_0_0_0_1px_rgb(var(--color-border))]">
        <AlertTriangle className="h-3 w-3" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p
          data-testid="assistant-error-title"
          className="text-sm font-semibold leading-5 text-text-primary"
        >
          {title}
        </p>
        <p
          data-testid="assistant-error-description"
          className="mt-0.5 text-xs leading-[18px] text-text-secondary"
        >
          {description}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onSwitchModel ? (
            <button
              type="button"
              data-testid="assistant-error-switch-model-retry"
              onClick={() => onSwitchModel(message)}
              className="h-8 rounded-lg border border-text-primary bg-text-primary px-3 text-xs font-semibold text-background hover:bg-text-primary/90"
            >
              {t("assistant_error.actions.switch_model_retry")}
            </button>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              data-testid="assistant-error-retry"
              onClick={() => onRetry(message)}
              className="h-8 rounded-lg border border-border bg-base px-3 text-xs font-semibold text-text-secondary hover:bg-muted hover:text-text-primary"
            >
              {t("assistant_error.actions.retry")}
            </button>
          ) : null}
          {hasErrorDetails && (
            <button
              type="button"
              data-testid="assistant-error-details-toggle"
              aria-expanded={isDetailExpanded}
              onClick={() => {
                reportReaderDisclosure();
                setIsDetailExpanded((value) => !value);
              }}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-base px-3 text-xs font-semibold text-text-secondary hover:bg-muted hover:text-text-primary"
            >
              <ChevronDown
                className={[
                  "h-3.5 w-3.5 transition-transform",
                  isDetailExpanded ? "rotate-180" : "",
                ].join(" ")}
              />
              {t("assistant_error.details")}
            </button>
          )}
        </div>
        {hasErrorDetails && (
          <pre
            data-testid="assistant-error-details"
            className={[
              "mt-2 max-w-full rounded-md bg-base px-2.5 py-1.5 font-mono text-xs leading-4 text-text-muted",
              isDetailExpanded
                ? "max-h-32 overflow-auto whitespace-pre-wrap break-words"
                : "overflow-hidden truncate whitespace-nowrap",
            ].join(" ")}
          >
            {displayError}
          </pre>
        )}
      </div>
    </div>
  );
}
