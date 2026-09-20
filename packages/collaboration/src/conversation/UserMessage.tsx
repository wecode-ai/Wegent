import { FileReferenceIcon } from '../composer/FileReferenceIcon'
import { MessageHoverActions } from './MessageHoverActions'
import { useMemo, useState } from 'react'
import {
  Braces,
  ChevronDown,
  ChevronUp,
  File as FileIcon,
  FileText,
  Folder,
  LibraryBig,
  ListTodo,
  MessageCircle,
  MessageSquare,
  Package,
  PackageOpen,
  Target,
} from 'lucide-react'
import type { Attachment } from '@wegent/chat-core/runtime'
import { useConversationTranslation } from './ConversationTranslation'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { MarkdownFileOpenOptions as WorkspaceFileOpenOptions } from '../markdown/MarkdownServices'
import {
  getAttachmentTextPreview,
  getAttachmentTypeLabel,
  isImageAttachment,
  isTextAttachment,
} from '../issue-detail/attachmentPresentation'
import {
  splitRuntimeUserMessage,
  visibleRuntimeUserMessage,
} from '@wegent/chat-core/runtime-user-message'
import { UserMessageEditForm } from './UserMessageEditForm'
import { isIMSource } from '@wegent/chat-core/im-source'
import { ImSourceBadge } from './ImSourceBadge'
import {
  pluginNameInitial,
  parsePluginUri,
  type PluginReference,
} from '@wegent/chat-core/plugin-reference'
import { AssistantMarkdown } from '../markdown/AssistantMarkdown'
import {
  AttachmentImageView,
  type AttachmentImageServices,
} from '../issue-detail/AttachmentImageView'
import { CodeCommentPreview } from './CodeCommentPreview'
import { CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL } from '@wegent/chat-core/runtime-user-input'
import {
  classifyComposerReference,
  composerSkillName,
  composerPathReference,
} from '../composer/composerMentions'
import { parseComposerReferences } from '../composer/composerReference'

import type { ComposerEditorServices } from '../composer/ComposerEditorServices'
import type { ComposerTransferServices } from '../composer/useComposerTransfers'

export interface UserMessageServices {
  localSkills?: readonly { name: string; path: string }[]
  images: AttachmentImageServices<Attachment>
  editor?: ComposerEditorServices
  transfers?: ComposerTransferServices
  resolveMentionIconUrl?: (href: string) => string | null
  onOpenPlugin?: (reference: PluginReference) => void
  openLocalAttachment?: (path: string, onOpenFile?: (path: string) => void) => Promise<void>
  getCommentPreviewRightBoundary?: () => number
}

const USER_MESSAGE_COLLAPSE_LINES = 10
const USER_MESSAGE_COLLAPSE_CHARACTERS = 600
const CODEX_FILE_MENTIONS_HEADER_PATTERN = /^\s*# Files mentioned by the user:\s*/i
const CODEX_FILE_MENTION_LINE_PATTERN = /^##\s+(.+?):\s+(.+)$/gm
const CODEX_IMPLEMENT_PLAN_USER_MESSAGE_PREFIX = 'PLEASE IMPLEMENT THIS PLAN:'
const LOCAL_IMAGE_EXTENSION_PATTERN = /\.(?:apng|avif|gif|jpe?g|png|webp|bmp|svg)$/i
const CODEX_TRANSIENT_CLIPBOARD_IMAGE_PATTERN =
  /\/(?:var\/folders|private\/var\/folders)\/.*\/codex-clipboard-[^/]+\.(?:apng|avif|gif|jpe?g|png|webp|bmp|svg)$/i
const LOCAL_IMAGE_MIME_TYPES: Record<string, string> = {
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

export function UserMessage({
  services,
  message,
  onBeforeToggle,
  onOpenWorkspaceFile,
  onOpenLocalSkillFile,
  editable = false,
  editing = false,
  editSubmitting = false,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  services: UserMessageServices
  message: WorkbenchMessage
  onBeforeToggle?: () => void
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  onOpenLocalSkillFile?: (path: string) => void
  editable?: boolean
  editing?: boolean
  editSubmitting?: boolean
  onStartEdit?: () => void
  onCancelEdit?: () => void
  onSubmitEdit?: (content: string) => Promise<boolean | void> | boolean | void
}) {
  const { t } = useConversationTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [areHoverActionsVisible, setAreHoverActionsVisible] = useState(false)
  const codexLocalFileMentions = useMemo(
    () => parseCodexLocalFileMentions(message.content),
    [message.content]
  )
  const displayContent = normalizeCodexUserMessageContent(
    codexLocalFileMentions?.requestText ?? visibleRuntimeUserMessage(message.content)
  )
  const imageAttachments = useMemo(
    () => (message.attachments ?? []).filter(isImageAttachment),
    [message.attachments]
  )
  const documentAttachments = useMemo(
    () => (message.attachments ?? []).filter(attachment => !isImageAttachment(attachment)),
    [message.attachments]
  )
  const localImageMentions = useMemo(
    () => (imageAttachments.length > 0 ? [] : (codexLocalFileMentions?.images ?? [])),
    [codexLocalFileMentions?.images, imageAttachments.length]
  )
  const localFileMentions = codexLocalFileMentions?.files ?? []
  const localImageAttachments = useMemo(
    () =>
      localImageMentions.map((image, index) =>
        createLocalImageMentionAttachment(image, index, message.createdAt)
      ),
    [localImageMentions, message.createdAt]
  )
  const imagePreviewAttachments = useMemo(
    () => (imageAttachments.length > 0 ? imageAttachments : localImageAttachments),
    [imageAttachments, localImageAttachments]
  )
  const hasImagePreviews = imagePreviewAttachments.length > 0
  const hasMultipleImagePreviews = imagePreviewAttachments.length > 1
  const collapseText = parseComposerReferences(displayContent).reduceRight(
    (text, link) =>
      classifyComposerReference(link.label, link.href)
        ? text.slice(0, link.start) + link.label.replace(/^[@$]/, '') + text.slice(link.end)
        : text,
    displayContent
  )
  const shouldCollapse =
    message.runtimeGuidance !== true &&
    (collapseText.length > USER_MESSAGE_COLLAPSE_CHARACTERS ||
      collapseText.split('\n').length > USER_MESSAGE_COLLAPSE_LINES)
  const showSourceBadge = isIMSource(message.source)
  const showGoalRequestBadge = message.runtimeGoalRequest === true
  const codeCommentCount = message.codeComments?.length ?? 0

  return (
    <div
      className={[
        'flex flex-col items-end gap-1.5',
        hasImagePreviews ? 'w-full max-w-full' : 'max-w-[80%]',
      ].join(' ')}
      data-testid="message-hover-region"
      onPointerEnter={() => setAreHoverActionsVisible(true)}
      onPointerLeave={() => setAreHoverActionsVisible(false)}
    >
      <div
        className={[
          'flex max-w-full flex-col items-end gap-1.5',
          hasImagePreviews ? 'w-full' : 'w-fit',
        ].join(' ')}
      >
        {(imagePreviewAttachments.length > 0 ||
          localFileMentions.length > 0 ||
          documentAttachments.length > 0) && (
          <div
            className={[
              'flex max-w-full flex-col items-end gap-2',
              hasImagePreviews ? 'w-full' : '',
            ].join(' ')}
          >
            {hasImagePreviews && (
              <div
                data-testid="message-image-attachments"
                className={[
                  'flex w-full max-w-full flex-row flex-nowrap gap-2',
                  hasMultipleImagePreviews
                    ? 'scrollbar-none overflow-x-auto overscroll-x-contain'
                    : 'justify-end overflow-visible',
                ].join(' ')}
              >
                <div
                  data-testid="message-image-attachment-strip"
                  className="ml-auto flex w-max max-w-none flex-row flex-nowrap justify-end gap-2"
                >
                  {imagePreviewAttachments.map((attachment, index) => (
                    <MessageImageAttachmentPreview
                      imageServices={services.images}
                      key={`${attachment.id}:${attachment.local_preview_url ?? attachment.filename}`}
                      attachment={attachment}
                      galleryAttachments={imagePreviewAttachments}
                      galleryIndex={index}
                      imageTestId={
                        imageAttachments.length > 0
                          ? 'message-image-preview'
                          : 'message-local-image-preview'
                      }
                      buttonTestId={
                        imageAttachments.length > 0
                          ? 'message-image-preview-button'
                          : 'message-local-image-preview-button'
                      }
                      loadingTestId={
                        imageAttachments.length > 0
                          ? 'message-image-preview-loading'
                          : 'message-local-image-preview-loading'
                      }
                      errorTestId={
                        imageAttachments.length > 0
                          ? 'message-image-preview-error'
                          : 'message-local-image-preview-error'
                      }
                      hideOnError={imageAttachments.length === 0}
                    />
                  ))}
                </div>
              </div>
            )}
            {localFileMentions.map(file => (
              <MessageCodexFileMention
                key={`${file.filename}:${file.path}`}
                file={file}
                onOpenFile={onOpenWorkspaceFile}
              />
            ))}
            {documentAttachments.map(attachment => (
              <MessageDocumentAttachment
                openLocalAttachment={services.openLocalAttachment}
                key={attachment.id}
                attachment={attachment}
                onOpenFile={onOpenWorkspaceFile}
              />
            ))}
          </div>
        )}
        {displayContent && editing ? (
          <UserMessageEditForm
            editorServices={services.editor}
            transferServices={services.transfers}
            onOpenMentionPlugin={services.onOpenPlugin}
            initialContent={displayContent}
            submitting={editSubmitting}
            onCancel={onCancelEdit}
            onSubmit={onSubmitEdit}
          />
        ) : displayContent ? (
          <div
            className={[
              'overflow-hidden rounded-2xl bg-muted text-base leading-5 text-text-primary',
              hasImagePreviews ? 'max-w-[80%]' : 'max-w-full',
            ].join(' ')}
          >
            <div
              data-testid="user-message-content"
              data-message-selectable-text
              className={[
                'relative overflow-hidden break-words bg-muted px-4 py-1.5',
                shouldCollapse && !isExpanded ? 'max-h-44' : '',
              ].join(' ')}
            >
              {renderUserContent(
                displayContent,
                services,
                onOpenLocalSkillFile,
                onOpenWorkspaceFile
              )}
              {showGoalRequestBadge && (
                <div className="mt-1.5 flex">
                  <span
                    data-testid="user-message-goal-badge"
                    className="inline-flex h-6 w-fit items-center gap-1 rounded-md border border-border/70 bg-background/70 px-2 text-xs font-medium leading-none text-text-secondary"
                  >
                    <Target className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('workbench.goal_chip')}</span>
                  </span>
                </div>
              )}
              {codeCommentCount > 0 && (
                <div className="mt-1.5 flex">
                  <CodeCommentPreview
                    getRightBoundary={services.getCommentPreviewRightBoundary}
                    comments={message.codeComments ?? []}
                    testId="message-code-comment-context-preview"
                  >
                    <span
                      data-testid="message-code-comment-context-badge"
                      tabIndex={0}
                      className="inline-flex h-6 w-fit items-center gap-1.5 rounded-md border border-border/70 bg-background/70 px-2 text-xs font-medium leading-none text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>
                        {t('workbench.code_comment_count', {
                          count: codeCommentCount,
                        })}
                      </span>
                    </span>
                  </CodeCommentPreview>
                </div>
              )}
              {shouldCollapse && !isExpanded && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-muted to-transparent" />
              )}
            </div>
            {shouldCollapse && (
              <button
                type="button"
                data-testid="toggle-user-message-button"
                aria-expanded={isExpanded}
                onClick={() => {
                  onBeforeToggle?.()
                  setIsExpanded(value => !value)
                }}
                className="flex h-9 w-full items-center justify-center gap-1 border-t border-border/60 text-xs font-medium text-text-secondary transition-colors hover:bg-surface"
              >
                {isExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                {t(isExpanded ? 'user_message.collapse' : 'user_message.expand')}
              </button>
            )}
          </div>
        ) : null}
        {showSourceBadge && (
          <div
            data-testid="message-source-row"
            className="flex min-h-5 items-center justify-end gap-1"
          >
            <ImSourceBadge source={message.source} testId="message-source-badge" />
          </div>
        )}
      </div>
      {!editing && (
        <MessageHoverActions
          message={message}
          copyContent={displayContent}
          align="right"
          visible={areHoverActionsVisible}
          onEdit={editable ? onStartEdit : undefined}
        />
      )}
    </div>
  )
}

function normalizeCodexUserMessageContent(content: string): string {
  return content.trimStart().startsWith(CODEX_IMPLEMENT_PLAN_USER_MESSAGE_PREFIX)
    ? CODEX_IMPLEMENT_PLAN_RESPONSE_LABEL
    : content
}

function parseCodexLocalFileMentions(content: string): {
  requestText: string
  images: Array<{ filename: string; path: string }>
  files: Array<{ filename: string; path: string }>
} | null {
  if (!CODEX_FILE_MENTIONS_HEADER_PATTERN.test(content)) return null

  const messageParts = splitRuntimeUserMessage(content)
  const requestText = messageParts?.request ?? ''
  const filesText = messageParts?.prefix ?? content
  const images: Array<{ filename: string; path: string }> = []
  const files: Array<{ filename: string; path: string }> = []
  for (const match of filesText.matchAll(CODEX_FILE_MENTION_LINE_PATTERN)) {
    const filename = match[1]?.trim()
    const path = match[2]?.trim()
    if (!filename || !path) continue
    if (isTransientCodexClipboardImage(path)) continue
    const target = { filename, path }
    if (isLocalImageMention(filename, path)) {
      if (!images.some(image => image.path === path || image.filename === filename)) {
        images.push(target)
      }
      continue
    }
    if (!files.some(file => file.path === path || file.filename === filename)) {
      files.push(target)
    }
  }

  if (!requestText && images.length === 0 && files.length === 0) return null

  return { requestText, images, files }
}

function isLocalImageMention(filename: string, path: string): boolean {
  return LOCAL_IMAGE_EXTENSION_PATTERN.test(filename) || LOCAL_IMAGE_EXTENSION_PATTERN.test(path)
}

function isTransientCodexClipboardImage(path: string): boolean {
  return CODEX_TRANSIENT_CLIPBOARD_IMAGE_PATTERN.test(path)
}

function getLocalImageExtension(filename: string, path: string): string {
  const source = LOCAL_IMAGE_EXTENSION_PATTERN.test(filename) ? filename : path
  const match = source.match(/(\.[a-z0-9]+)(?:[?#].*)?$/i)
  return match?.[1]?.toLowerCase() ?? ''
}

function createLocalImageMentionAttachment(
  image: { filename: string; path: string },
  index: number,
  createdAt: string
): Attachment {
  const fileExtension = getLocalImageExtension(image.filename, image.path)

  return {
    id: -100000 - index,
    filename: image.filename,
    file_size: 0,
    mime_type: LOCAL_IMAGE_MIME_TYPES[fileExtension] ?? 'image/png',
    status: 'ready',
    file_extension: fileExtension,
    created_at: createdAt,
    local_preview_url: image.path,
  }
}

function MessageCodexFileMention({
  file,
  onOpenFile,
}: {
  file: { filename: string; path: string }
  onOpenFile?: (path: string) => void
}) {
  const useBracesIcon = shouldUseBracesFileIcon(file.filename)
  const Icon = useBracesIcon ? Braces : FileIcon
  const iconTestId = useBracesIcon
    ? 'message-codex-file-braces-icon'
    : 'message-codex-file-document-icon'

  return (
    <button
      type="button"
      data-testid="message-codex-file-mention"
      className="inline-flex h-10 max-w-[260px] items-center gap-2 rounded-2xl border border-border bg-base px-3 text-left text-sm font-semibold leading-none text-text-primary shadow-sm hover:bg-muted"
      title={file.path}
      aria-label={file.filename}
      disabled={!onOpenFile}
      onClick={() => onOpenFile?.(file.path)}
    >
      <Icon
        data-testid={iconTestId}
        className="h-3.5 w-3.5 shrink-0 text-text-muted"
        strokeWidth={1.8}
      />
      <span className="min-w-0 truncate">{file.filename}</span>
    </button>
  )
}

function shouldUseBracesFileIcon(filename: string): boolean {
  return /\.(?:json|jsonc)$/i.test(filename)
}

function openableAttachmentPath(attachment: Attachment): string | null {
  return attachment.local_path?.trim() || attachment.local_preview_url?.trim() || null
}

function MessageDocumentAttachment({
  openLocalAttachment,
  attachment,
  onOpenFile,
}: {
  openLocalAttachment?: UserMessageServices['openLocalAttachment']
  attachment: Attachment
  onOpenFile?: (path: string) => void
}) {
  if (isTextAttachment(attachment)) {
    return (
      <MessageTextAttachment
        openLocalAttachment={openLocalAttachment}
        attachment={attachment}
        onOpenFile={onOpenFile}
      />
    )
  }

  const typeLabel = getAttachmentTypeLabel(attachment)

  return (
    <div
      data-testid="message-document-attachment"
      className="flex h-14 w-[220px] max-w-full items-center gap-3 rounded-2xl border border-border bg-base px-3 text-left text-xs text-text-secondary shadow-sm"
      aria-label={attachment.filename}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-xs font-semibold leading-none text-red-600">
        {typeLabel}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-text-primary">{attachment.filename}</span>
        <span className="truncate text-text-muted">{typeLabel}</span>
      </span>
    </div>
  )
}

function MessageTextAttachment({
  openLocalAttachment,
  attachment,
  onOpenFile,
}: {
  openLocalAttachment?: UserMessageServices['openLocalAttachment']
  attachment: Attachment
  onOpenFile?: (path: string) => void
}) {
  const preview = getAttachmentTextPreview(attachment) ?? attachment.filename
  const attachmentPath = openableAttachmentPath(attachment)
  const clickable = Boolean(attachmentPath && (openLocalAttachment || onOpenFile))
  const className =
    'inline-flex h-9 max-w-[min(360px,100%)] items-center gap-2 rounded-full border border-border bg-muted px-3 text-left text-sm font-semibold leading-none text-text-primary shadow-sm'
  const content = (
    <>
      <FileText
        data-testid="message-text-attachment-icon"
        className="h-3.5 w-3.5 shrink-0 text-text-muted"
        strokeWidth={1.8}
      />
      <span data-testid="message-text-attachment-preview" className="min-w-0 truncate">
        {preview}
      </span>
    </>
  )

  if (clickable && attachmentPath) {
    return (
      <button
        type="button"
        data-testid="message-text-attachment"
        className={`${className} cursor-pointer hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}
        aria-label={preview}
        title={preview}
        onClick={() => {
          if (openLocalAttachment) void openLocalAttachment(attachmentPath, onOpenFile)
          else onOpenFile?.(attachmentPath)
        }}
      >
        {content}
      </button>
    )
  }

  return (
    <div
      data-testid="message-text-attachment"
      className={className}
      aria-label={preview}
      title={preview}
    >
      {content}
    </div>
  )
}

function MessageImageAttachmentPreview({
  imageServices,
  attachment,
  galleryAttachments,
  galleryIndex,
  buttonTestId = 'message-image-preview-button',
  imageTestId = 'message-image-preview',
  loadingTestId = 'message-image-preview-loading',
  errorTestId = 'message-image-preview-error',
  hideOnError = false,
}: {
  imageServices: AttachmentImageServices<Attachment>
  attachment: Attachment
  galleryAttachments: Attachment[]
  galleryIndex: number
  buttonTestId?: string
  imageTestId?: string
  loadingTestId?: string
  errorTestId?: string
  hideOnError?: boolean
}) {
  return (
    <AttachmentImageView
      services={imageServices}
      attachment={attachment}
      buttonTestId={buttonTestId}
      imageTestId={imageTestId}
      loadingTestId={loadingTestId}
      errorTestId={errorTestId}
      imageClassName="block h-20 w-20 shrink-0 rounded-xl border border-border bg-base object-cover"
      placeholderClassName="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-text-muted"
      buttonClassName="block h-20 w-20 shrink-0 cursor-zoom-in p-0 text-left"
      galleryAttachments={galleryAttachments}
      galleryIndex={galleryIndex}
      hideOnError={hideOnError}
    />
  )
}

function codexMentionTokenTestId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function displayCodexMentionName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function cloudReferenceKind(href: string): 'project' | 'todo' | 'file' | 'delivery' {
  if (/\/todos\/[^/]+$/.test(href)) return 'todo'
  if (/\/files\/[^/]+$/.test(href)) return 'file'
  if (/\/deliveries\/[^/]+$/.test(href)) return 'delivery'
  return 'project'
}

function renderUserContent(
  content: string,
  services: UserMessageServices,
  onOpenLocalSkillFile?: (path: string) => void,
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
) {
  return (
    <AssistantMarkdown
      content={content}
      variant="user"
      onOpenFile={onOpenWorkspaceFile}
      renderLink={(linkHref, text) => {
        const reference = '[' + text + '](' + linkHref + ')'
        const mentionKind = classifyComposerReference(text, linkHref)
        if (!mentionKind) return undefined
        const skill = composerSkillName(text)
        const mentionName = mentionKind === 'skill' ? skill.name : text.replace(/^[@$]/, '')
        const href = linkHref
        const skillFilePath = mentionKind === 'skill' ? linkHref.replace(/^skill:\/\//, '') : null
        const pathReference = composerPathReference(reference)
        const matchingSkills = skillFilePath
          ? (services.localSkills?.filter(
              item => item.path.replace(/\\/g, '/') === skillFilePath.replace(/\\/g, '/')
            ) ?? [])
          : []
        const knownSkill = matchingSkills.length === 1 ? matchingSkills[0] : undefined
        const canOpenSkill = Boolean(knownSkill && onOpenLocalSkillFile)
        const cloudKind = mentionKind === 'cloud' ? cloudReferenceKind(href) : undefined
        const brandIconUrl =
          mentionKind === 'plugin' || mentionKind === 'app'
            ? (services.resolveMentionIconUrl?.(href) ?? null)
            : null
        const tokenTestId = codexMentionTokenTestId(mentionName)
        const testId =
          mentionKind === 'skill'
            ? `sent-local-skill-token-${tokenTestId}`
            : `sent-${mentionKind}-token-${tokenTestId}`
        const iconTestId =
          mentionKind === 'skill'
            ? `sent-local-skill-icon-${tokenTestId}`
            : `sent-${mentionKind}-icon-${tokenTestId}`
        const canOpen = Boolean(
          canOpenSkill ||
          (pathReference && onOpenWorkspaceFile) ||
          (parsePluginUri(href) && services.onOpenPlugin)
        )
        return (
          <a
            href={href}
            aria-disabled={!canOpen}
            tabIndex={canOpen ? 0 : -1}
            data-testid={testId}
            data-cloud-resource-kind={cloudKind}
            className="composer-mention-node gap-1 rounded-xl bg-muted text-blue-600 no-underline [&>:first-child]:self-center"
            onClick={event => {
              event.preventDefault()
              if (canOpenSkill && knownSkill) onOpenLocalSkillFile?.(knownSkill.path)
              if (pathReference) {
                onOpenWorkspaceFile?.(
                  pathReference.path,
                  pathReference.directory ? { isDirectory: true } : undefined
                )
              }
              const pluginReference = parsePluginUri(href)
              if (pluginReference) services.onOpenPlugin?.(pluginReference)
            }}
          >
            {mentionKind === 'folder' ? (
              <Folder data-testid={iconTestId} className="h-3.5 w-3.5 shrink-0 text-blue-600" />
            ) : mentionKind === 'file' ? (
              <FileReferenceIcon path={pathReference?.path ?? href} data-testid={iconTestId} className="h-3.5 w-3.5 shrink-0 text-blue-600" />
            ) : mentionKind === 'cloud' ? (
              cloudKind === 'todo' ? (
                <ListTodo data-testid={iconTestId} className="h-3.5 w-3.5 shrink-0 text-blue-600" />
              ) : cloudKind === 'file' ? (
                <FileIcon data-testid={iconTestId} className="h-3.5 w-3.5 shrink-0 text-blue-600" />
              ) : cloudKind === 'delivery' ? (
                <PackageOpen
                  data-testid={iconTestId}
                  className="h-3.5 w-3.5 shrink-0 text-blue-600"
                />
              ) : (
                <LibraryBig
                  data-testid={iconTestId}
                  className="h-3.5 w-3.5 shrink-0 text-blue-600"
                />
              )
            ) : mentionKind === 'conversation' ? (
              <MessageCircle
                data-testid={iconTestId}
                className="h-3.5 w-3.5 shrink-0 text-blue-600"
              />
            ) : brandIconUrl ? (
              <img
                data-testid={iconTestId}
                src={brandIconUrl}
                alt=""
                className="h-3.5 w-3.5 shrink-0 rounded-sm object-cover"
              />
            ) : mentionKind === 'plugin' || mentionKind === 'app' ? (
              <span
                data-testid={iconTestId}
                className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm bg-blue-600/10 text-xs font-medium leading-none text-blue-600"
              >
                <span className="scale-75">{pluginNameInitial(mentionName)}</span>
              </span>
            ) : (
              <Package data-testid={iconTestId} className="h-3.5 w-3.5 shrink-0 text-blue-600" />
            )}
            <span className="min-w-0 truncate">
              {mentionKind === 'skill'
                ? skill.displayLabel ??
                  (knownSkill ? displayCodexMentionName(knownSkill.name) : `$${skill.name}`)
                : mentionKind === 'file' ||
                    mentionKind === 'folder' ||
                    mentionKind === 'cloud' ||
                    mentionKind === 'conversation'
                  ? mentionName
                  : displayCodexMentionName(mentionName)}
            </span>
          </a>
        )
      }}
    />
  )
}
