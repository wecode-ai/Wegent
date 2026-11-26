import { TextField as ControlInput } from '../controls/TextField'
import { Textarea as ControlTextarea } from '../controls/Textarea'
import type { ComponentProps } from 'react'
import type { TodoEditorProps } from './issueEditorSupport'
import { Popover, PopoverTrigger, PopoverContent } from '../controls/Popover'
import { Calendar, ChevronDown, File, Trash2 } from 'lucide-react'
import { IssueDetailAttachments, type IssueDetailAttachment } from './index'
import { useCollaborationPortalTheme } from '../theme'
import { cn, scheduleRangeLabel, avatarPalette, type AttachmentRow } from './issueEditorSupport'
export function IssueTitleField({ className, ...props }: ComponentProps<typeof ControlTextarea>) {
  return (
    <ControlTextarea
      {...props}
      aria-required="true"
      rows={1}
      maxLength={255}
      className={cn(
        'block w-full resize-none overflow-hidden border-0 bg-transparent font-medium tracking-tight text-text-primary outline-none placeholder:text-text-secondary',
        className
      )}
    />
  )
}

export function ScheduleRangeControl({
  startDate,
  dueDate,
  inputType,
  editable,
  invalid,
  triggerClassName,
  showLabel = true,
  startTestId,
  dueTestId,
  onStartDateChange,
  onDueDateChange,
  translate,
}: {
  startDate: string
  dueDate: string
  inputType: 'date' | 'datetime-local'
  editable: boolean
  invalid: boolean
  triggerClassName: string
  showLabel?: boolean
  startTestId: string
  dueTestId: string
  onStartDateChange?(value: string): void
  onDueDateChange(value: string): void
  translate: NonNullable<TodoEditorProps['translate']>
}) {
  const portalTheme = useCollaborationPortalTheme()
  const notSetLabel = translate('todo.add_date', '添加时间')
  const label = scheduleRangeLabel(startDate, dueDate, notSetLabel)

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={triggerClassName}
            disabled={!editable}
            data-testid={`${startTestId}-trigger`}
            aria-label={translate('todo.schedule_range', '时间范围')}
          />
        }
      >
        <Calendar className="h-4 w-4 shrink-0 text-text-muted" />
        {showLabel ? (
          <span className="text-text-secondary">
            {translate('todo.schedule_range', '时间范围')}
          </span>
        ) : null}
        <span
          className={cn(
            'max-w-64 truncate text-text-primary',
            !startDate && !dueDate && 'text-text-secondary',
            invalid && 'text-destructive'
          )}
        >
          {label}
        </span>
        {editable ? <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" /> : null}
      </PopoverTrigger>
      <PopoverContent
        {...portalTheme}
        sideOffset={4}
        collisionPadding={8}
        align="start"
        className={`z-critical w-80 rounded-xl border border-border bg-popover p-3 shadow-xl outline-none ${portalTheme.className}`}
        style={portalTheme.style}
      >
        <div className="grid gap-3">
          {onStartDateChange ? (
            <label className="grid gap-1.5 text-xs text-text-secondary">
              {translate('todo.start_date', '开始时间')}
              <ControlInput
                data-testid={startTestId}
                type={inputType}
                value={startDate}
                onClick={event => event.currentTarget.showPicker?.()}
                onChange={event => onStartDateChange(event.target.value)}
                className="h-11 rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-text-muted md:h-9"
              />
            </label>
          ) : null}
          <label className="grid gap-1.5 text-xs text-text-secondary">
            {translate('todo.due_date', '结束时间')}
            <ControlInput
              data-testid={dueTestId}
              type={inputType}
              value={dueDate}
              onClick={event => event.currentTarget.showPicker?.()}
              onChange={event => onDueDateChange(event.target.value)}
              className="h-11 rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-text-muted md:h-9"
            />
          </label>
          {invalid ? (
            <p className="text-xs text-destructive">
              {translate('todo.schedule_range_invalid', '开始时间不能晚于结束时间')}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
export function AvatarMark({
  name,
  index = 0,
  size = 'md',
}: {
  name: string
  index?: number
  size?: 'sm' | 'md'
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold text-background',
        size === 'md' ? 'h-6 w-6 text-xs' : 'h-5 w-5 text-xs',
        avatarPalette[index % avatarPalette.length]
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}
export function TodoAttachmentSection({
  attachments,
  busy,
  error,
  editable,
  compactRail = false,
  openTestId,
  openLabel,
  totalCount,
  downloadingId,
  onAdd,
  onReadPreview,
  onOpen,
  onDownload,
  onRemove,
  translate,
}: {
  attachments: AttachmentRow[]
  busy: boolean
  error: string | null
  editable: boolean
  compactRail?: boolean
  openTestId?: (id: string) => string
  openLabel?: (name: string) => string
  totalCount?: number
  downloadingId?: string | null
  onAdd: (files: FileList | null) => Promise<void>
  onReadPreview?: (attachmentId: string) => Promise<Blob>
  onOpen?: (attachment: AttachmentRow) => Promise<void>
  onDownload?: (attachment: AttachmentRow) => Promise<void>
  onRemove: (attachment: AttachmentRow) => Promise<void>
  translate: (key: string, fallback?: string, options?: Record<string, string | number>) => string
}) {
  const sharedAttachments: IssueDetailAttachment[] = attachments.map(attachment => ({
    id: attachment.id,
    displayName: attachment.display_name,
    removable: attachment.removable,
    contentType: attachment.content_type,
    sizeBytes: attachment.size_bytes,
  }))
  const byId = new Map(attachments.map(attachment => [attachment.id, attachment]))
  return (
    <IssueDetailAttachments
      attachments={sharedAttachments}
      busy={busy}
      error={error}
      editable={editable}
      compact={compactRail}
      totalCount={totalCount}
      downloadingId={downloadingId}
      labels={{
        title: translate('todo.attachment', '附件'),
        upload: translate('todo.upload', '＋ 上传'),
        uploading: translate('todo.uploading', '上传中…'),
        empty: translate('todo.no_attachments', '暂无附件'),
        dropzone: translate('todo.attachment_dropzone', '点击上传或拖拽文件到这里'),
        downloading: translate('todo.file_downloading', '下载中…'),
        open:
          openLabel ??
          (name =>
            translate('todo.preview_task_attachment', '预览任务附件 {{name}}', {
              name,
            })),
        expand: count =>
          translate('todo.view_all_count', '查看全部 {{count}} 个', {
            count,
          }),
        collapse: translate('todo.collapse', '收起'),
        download: name => translate('todo.download_name', '下载 {{name}}', { name }),
        remove: name => translate('todo.remove_name', '删除 {{name}}', { name }),
      }}
      testIdPrefix="cloud-todo-attachment"
      openTestId={openTestId}
      icons={{
        file: <File className="icon" />,
        remove: <Trash2 className="icon" />,
      }}
      onAdd={onAdd}
      loadPreview={onReadPreview}
      onOpen={
        onOpen
          ? async attachment => {
              const original = byId.get(attachment.id)
              if (original) await onOpen(original)
            }
          : undefined
      }
      onDownload={
        !compactRail && onDownload
          ? async attachment => {
              const original = byId.get(attachment.id)
              if (original) await onDownload(original)
            }
          : undefined
      }
      onRemove={async attachment => {
        const original = byId.get(attachment.id)
        if (original) await onRemove(original)
      }}
    />
  )
}
