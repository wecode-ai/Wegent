import Ionicons from '@expo/vector-icons/Ionicons'
import { useState } from 'react'
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'

import {
  buildMessageDisplaySegments,
  fileChangeLabel,
  generatedImagesFromBlocks,
  processingActivityStats,
  processingDurationLabel,
  processingSegmentTitle,
  shouldCollapseCompletedProcessing,
  type GeneratedImageArtifact,
  type MessageDisplayRow,
  type MessageDisplaySegment,
  type ToolActivityKind,
} from '@/domain/messagePresentation'
import type {
  ChatFileChangesBlock,
  ChatMessage,
  ChatProcessingBlock,
  ChatToolBlock,
} from '@/types/runtime'
import { AssistantMarkdown } from './AssistantMarkdown'
import { isRequestUserInputBlock, requestUserInputPayloadKey } from '@/domain/requestUserInput'
import { RequestUserInputCard, type RequestUserInputHandlers } from './RequestUserInputCard'
import { useMobileFilePreview } from './files/FilePreviewContext'

interface UserInputPresentation extends RequestUserInputHandlers {
  pendingInputKeys?: ReadonlySet<string>
}

export function ProcessingTimeline({
  message,
  ...userInput
}: { message: ChatMessage } & UserInputPresentation) {
  const segments = buildMessageDisplaySegments(message.blocks, message.content)
  const rows = segments.flatMap(segment => segment.rows)
  const images = generatedImagesFromBlocks(message.blocks)
  const [expanded, setExpanded] = useState(false)
  if (!rows.length && !images.length) return null

  const collapsed =
    !rows.some(isRequestUserInputRow) &&
    shouldCollapseCompletedProcessing(message.blocks, message.content, rows)
  const timeline = !rows.length ? null : !collapsed ? (
    <View style={styles.timeline} testID={`processing-timeline-${message.id}`}>
      {segments.map(segment => (
        <ProcessingSegment key={segment.id} segment={segment} {...userInput} />
      ))}
    </View>
  ) : (
    <View style={styles.completedTimeline} testID={`completed-processing-${message.id}`}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded(current => !current)}
        style={styles.completedHeader}
        testID={`completed-processing-toggle-${message.id}`}
      >
        <Text style={styles.completedLabel} variant="bodyMedium">
          {processingDurationLabel(message.blocks, message.createdAt, message.completedAt)}
        </Text>
        <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={16} />
      </Pressable>
      {expanded ? (
        <View style={styles.completedContent} testID={`completed-processing-content-${message.id}`}>
          {segments.map(segment => (
            <ProcessingSegment key={segment.id} segment={segment} {...userInput} />
          ))}
        </View>
      ) : null}
    </View>
  )

  return (
    <>
      {timeline}
      {images.length ? <GeneratedImageGallery images={images} /> : null}
    </>
  )
}

function ProcessingSegment({
  segment,
  ...userInput
}: { segment: MessageDisplaySegment } & UserInputPresentation) {
  if (segment.kind === 'tool') {
    const groups: MessageDisplayRow[][] = []
    for (const row of segment.rows) {
      if (
        isRequestUserInputRow(row) ||
        !groups.length ||
        groups.at(-1)?.some(isRequestUserInputRow)
      )
        groups.push([row])
      else groups.at(-1)!.push(row)
    }
    return (
      <>
        {groups.map((rows, index) => {
          const first = rows[0]!
          if (first.type === 'tool' && isRequestUserInputBlock(first.block)) {
            const key = requestUserInputPayloadKey(first.block.renderPayload)
            return (
              <RequestUserInputCard
                key={key ?? first.id}
                block={first.block}
                active={Boolean(key && userInput.pendingInputKeys?.has(key))}
                onRequestUserInputSubmit={userInput.onRequestUserInputSubmit}
                onRequestUserInputSkip={userInput.onRequestUserInputSkip}
              />
            )
          }
          return <ToolProcessingSegment key={`${segment.id}:${index}`} rows={rows} />
        })}
      </>
    )
  }
  return (
    <View style={styles.narrativeSegment}>
      {segment.rows.map(row => (
        <ProcessingRow key={row.id} row={row} />
      ))}
    </View>
  )
}

function ToolProcessingSegment({ rows }: { rows: MessageDisplayRow[] }) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const stats = processingActivityStats(rows)
  const running = rows.some(isProcessingRowRunning)
  const contentExpanded = expanded
  const color = theme.colors.onSurfaceVariant
  const details = (
    <View style={styles.segmentDetails} testID="processing-segment-details">
      {rows.map(row => (
        <ProcessingRow initialGroupExpanded key={row.id} row={row} />
      ))}
    </View>
  )

  return (
    <View style={styles.toolSegment} testID="processing-tool-segment">
      <Pressable
        accessibilityRole={running ? undefined : 'button'}
        disabled={running}
        onPress={() => setExpanded(current => !current)}
        style={styles.segmentHeader}
        testID="processing-segment-toggle"
      >
        <Ionicons
          color={color}
          name={contentExpanded ? 'chevron-down' : 'chevron-forward'}
          size={15}
        />
        <Text numberOfLines={1} style={[styles.segmentTitle, { color }]} variant="bodyMedium">
          {processingSegmentTitle(rows)}
        </Text>
        <ProcessingStats color={color} stats={stats} />
        {running ? <ActivityIndicator size={14} /> : null}
      </Pressable>
      {contentExpanded ? (
        details
      ) : running ? (
        <View style={styles.livePreview}>{details}</View>
      ) : null}
    </View>
  )
}

function ProcessingStats({
  color,
  stats,
}: {
  color: string
  stats: ReturnType<typeof processingActivityStats>
}) {
  const items: Array<{
    count: number
    icon: keyof typeof Ionicons.glyphMap
    key: keyof typeof stats
  }> = [
    { key: 'command', count: stats.command, icon: 'terminal-outline' },
    { key: 'file', count: stats.file, icon: 'document-text-outline' },
    { key: 'search', count: stats.search, icon: 'search-outline' },
    { key: 'edit', count: stats.edit, icon: 'pencil-outline' },
    { key: 'other', count: stats.other, icon: 'construct-outline' },
  ]
  return (
    <View style={styles.processingStats}>
      {items
        .filter(item => item.count > 0)
        .map(item => (
          <View key={item.key} style={styles.processingStat}>
            <Ionicons color={color} name={item.icon} size={16} />
            <Text style={{ color }} variant="bodySmall">
              {item.count}
            </Text>
          </View>
        ))}
    </View>
  )
}

function isProcessingRowRunning(row: MessageDisplayRow): boolean {
  if (row.type === 'tool-group') {
    return row.blocks.some(block => block.status !== 'done' && block.status !== 'error')
  }
  return row.block.status !== 'done' && row.block.status !== 'error'
}

function isRequestUserInputRow(row: MessageDisplayRow): boolean {
  return row.type === 'tool' && isRequestUserInputBlock(row.block)
}

function GeneratedImageGallery({ images }: { images: GeneratedImageArtifact[] }) {
  const preview = useMobileFilePreview()
  const theme = useTheme()
  return (
    <View style={styles.generatedImageGallery} testID="generated-image-gallery">
      {images.map((image, index) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`预览 ${image.alt}`}
          disabled={!preview}
          key={image.id}
          onPress={() => {
            const name = `generated-image-${index + 1}${image.fileExtension}`
            if (image.workspaceFile)
              preview?.openAttachment({
                id: index + 1,
                filename: name,
                file_size: image.size,
                mime_type: image.mimeType,
                status: 'ready',
                file_extension: image.fileExtension,
                created_at: '',
                workspace_file: image.workspaceFile,
                image_width: image.width,
                image_height: image.height,
              })
            else if (image.src) preview?.openFile({ kind: 'image', dataUri: image.src, name })
          }}
          testID={`generated-image-preview-${image.id}`}
        >
          {image.src ? (
            <Image
              accessibilityLabel={image.alt}
              resizeMode="contain"
              source={{ uri: image.src }}
              style={styles.generatedImage}
              testID="generated-image"
            />
          ) : (
            <View style={[styles.generatedImage, styles.generatedImagePlaceholder]}>
              <Ionicons color={theme.colors.onSurfaceVariant} name="image-outline" size={36} />
              <Text numberOfLines={2}>{image.alt}</Text>
              <Text variant="labelMedium">查看生成图片</Text>
            </View>
          )}
        </Pressable>
      ))}
    </View>
  )
}

function ProcessingRow({
  initialGroupExpanded = false,
  row,
}: {
  initialGroupExpanded?: boolean
  row: MessageDisplayRow
}) {
  const theme = useTheme()
  if (row.type === 'tool-group') {
    return <ToolActivityGroup initialExpanded={initialGroupExpanded} row={row} />
  }
  if (row.type === 'file-changes') return <FileChangesActivityGroup block={row.block} />
  if (row.type === 'tool') return <ToolActivity block={row.block} kind={row.kind} />

  const { block } = row
  if (!block.content.trim()) return null
  if (block.type === 'error') {
    return (
      <Text style={[styles.error, { color: theme.colors.error }]} variant="bodyMedium">
        {block.content}
      </Text>
    )
  }
  return <AssistantMarkdown muted={block.type === 'guidance'}>{block.content}</AssistantMarkdown>
}

function ToolActivityGroup({
  initialExpanded,
  row,
}: {
  initialExpanded: boolean
  row: Extract<MessageDisplayRow, { type: 'tool-group' }>
}) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(initialExpanded)
  const color = row.failed ? theme.colors.error : theme.colors.onSurfaceVariant
  return (
    <View style={styles.activityGroup}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded(current => !current)}
        style={styles.activityRow}
        testID={`tool-group-toggle-${row.id}`}
      >
        <Ionicons color={color} name={activityIcon(row.kind)} size={17} />
        <Text numberOfLines={1} style={[styles.activityLabel, { color }]} variant="bodyMedium">
          {row.label}
        </Text>
        {row.kind === 'guidance' ? null : (
          <Ionicons color={color} name={expanded ? 'chevron-down' : 'chevron-forward'} size={16} />
        )}
      </Pressable>
      {expanded ? (
        <View
          style={[styles.activityDetails, { borderLeftColor: theme.colors.outlineVariant }]}
          testID={`tool-group-details-${row.id}`}
        >
          {row.blocks.map(block => (
            <ToolActivityDetail block={block} key={block.id} />
          ))}
        </View>
      ) : null}
    </View>
  )
}

function ToolActivity({ block, kind }: { block: ChatToolBlock; kind: ToolActivityKind }) {
  const theme = useTheme()
  const running = block.status !== 'done' && block.status !== 'error'
  const color = block.status === 'error' ? theme.colors.error : theme.colors.onSurfaceVariant
  if (isContextCompactionName(block.toolName)) return <ContextCompactionActivity block={block} />
  return (
    <View style={styles.standaloneTool} testID={`tool-block-${block.id}`}>
      <View style={styles.activityRow}>
        {running ? (
          <ActivityIndicator size={16} />
        ) : (
          <Ionicons
            color={color}
            name={block.status === 'error' ? 'alert-circle-outline' : activityIcon(kind)}
            size={18}
          />
        )}
        <Text style={[styles.activityLabel, { color }]} variant="bodyMedium">
          {toolStatusLabel(block, kind)}
        </Text>
      </View>
    </View>
  )
}

function ContextCompactionActivity({ block }: { block: ChatToolBlock }) {
  const theme = useTheme()
  const color = block.status === 'error' ? theme.colors.error : theme.colors.onSurfaceVariant
  return (
    <View style={styles.contextCompaction} testID="context-compaction-indicator">
      <View style={[styles.contextDivider, { backgroundColor: theme.colors.outlineVariant }]} />
      <Ionicons color={color} name="archive-outline" size={17} />
      <Text style={[styles.contextLabel, { color }]} variant="bodyMedium">
        {toolStatusLabel(block, 'tool')}
      </Text>
      <View style={[styles.contextDivider, { backgroundColor: theme.colors.outlineVariant }]} />
    </View>
  )
}

function ToolActivityDetail({ block }: { block: ChatToolBlock }) {
  const theme = useTheme()
  const preview = useMobileFilePreview()
  const paths = toolFilePaths(block)
  const error = block.status === 'error'
  return (
    <View style={styles.activityDetailRow}>
      <Ionicons
        color={error ? theme.colors.error : theme.colors.onSurfaceVariant}
        name={error ? 'alert-circle-outline' : 'checkmark-circle-outline'}
        size={16}
      />
      {paths.length ? (
        <View style={{ flex: 1, gap: 4 }}>
          {paths.map(path => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`查看 ${path}`}
              disabled={!preview?.target}
              key={path}
              onPress={() => preview?.openWorkspaceFile(path)}
              testID={`tool-file-preview-${block.id}-${path}`}
            >
              <Text numberOfLines={3} style={{ color: theme.colors.onSurfaceVariant }}>
                {path}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Text
          numberOfLines={3}
          style={{ color: theme.colors.onSurfaceVariant }}
          variant="bodyMedium"
        >
          {toolDetail(block)}
        </Text>
      )}
    </View>
  )
}

function FileChangesActivityGroup({ block }: { block: ChatFileChangesBlock }) {
  const theme = useTheme()
  const preview = useMobileFilePreview()
  const [expanded, setExpanded] = useState(false)
  const running = block.status !== 'done' && block.status !== 'error'
  return (
    <View style={styles.fileActivity} testID={`process-file-changes-${block.id}`}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded(current => !current)}
        style={styles.activityRow}
        testID={`file-changes-activity-toggle-${block.id}`}
      >
        <Text style={{ color: theme.colors.onSurfaceVariant }} variant="bodyMedium">
          编辑 {block.fileChanges.fileCount} 个文件
        </Text>
        <Ionicons color={theme.colors.onSurfaceVariant} name="pencil-outline" size={17} />
        <Text style={{ color: theme.colors.onSurfaceVariant }} variant="bodySmall">
          {block.fileChanges.fileCount}
        </Text>
        <Ionicons
          color={theme.colors.onSurfaceVariant}
          name={expanded ? 'chevron-down' : 'chevron-forward'}
          size={16}
        />
      </Pressable>
      {expanded
        ? block.fileChanges.files.map(file => (
            <Pressable
              style={styles.fileActivityRow}
              key={`${file.oldPath ?? ''}:${file.path}`}
              accessibilityRole="button"
              accessibilityLabel={`查看 ${file.path}`}
              disabled={!preview || (!block.fileChanges.source && !preview.target)}
              onPress={() =>
                block.fileChanges.source
                  ? preview?.openChanges(block.fileChanges.source, file.path)
                  : preview?.openWorkspaceFile(file.path)
              }
              testID={`process-file-preview-${block.id}-${file.path}`}
            >
              <Ionicons
                color={theme.colors.onSurfaceVariant}
                name="document-text-outline"
                size={17}
              />
              <Text
                numberOfLines={1}
                style={[styles.fileActivityLabel, { color: theme.colors.onSurfaceVariant }]}
                variant="bodyMedium"
              >
                {fileChangeLabel(file, running)}
              </Text>
              {!file.binary ? (
                <View style={styles.fileStats}>
                  <Text style={styles.additions} variant="bodySmall">
                    +{file.additions}
                  </Text>
                  <Text style={styles.deletions} variant="bodySmall">
                    −{file.deletions}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          ))
        : null}
    </View>
  )
}

function activityIcon(kind: ToolActivityKind): keyof typeof Ionicons.glyphMap {
  if (kind === 'web') return 'globe-outline'
  if (kind === 'file') return 'document-text-outline'
  if (kind === 'search') return 'search-outline'
  if (kind === 'command') return 'terminal-outline'
  if (kind === 'create') return 'add-circle-outline'
  if (kind === 'edit') return 'pencil-outline'
  if (kind === 'guidance') return 'chatbubble-ellipses-outline'
  return 'construct-outline'
}

function toolStatusLabel(block: ChatToolBlock, kind: ToolActivityKind): string {
  const running = block.status !== 'done' && block.status !== 'error'
  const failed = block.status === 'error'
  const normalizedName = block.toolName.trim().toLowerCase()
  if (normalizedName === 'runtime_reconnecting') return '连接中断，正在重连…'
  if (isContextCompactionName(normalizedName)) {
    return failed ? '上下文压缩失败' : running ? '正在自动压缩上下文' : '上下文已自动压缩'
  }
  if (normalizedName === 'image_generation') {
    return failed ? '生成图片失败' : running ? '正在生成图片' : '已生成图片'
  }
  if (kind === 'web') return failed ? '搜索网页失败' : running ? '正在搜索网页' : '已搜索网页'
  if (kind === 'search') return failed ? '搜索代码失败' : running ? '正在搜索代码' : '已搜索代码'
  if (kind === 'file') return failed ? '读取文件失败' : running ? '正在读取文件' : '已读取文件'
  if (kind === 'command') return failed ? '运行命令失败' : running ? '正在运行命令' : '已运行命令'
  if (kind === 'edit') return failed ? '编辑文件失败' : running ? '正在编辑文件' : '已编辑文件'
  if (kind === 'create') return failed ? '新增文件失败' : running ? '正在新增文件' : '已新增文件'
  if (kind === 'guidance') return failed ? '引导对话失败' : running ? '正在引导对话' : '已引导对话'
  const name = readableToolName(block.toolName)
  return failed ? `调用 ${name} 失败` : running ? `正在调用 ${name}` : `已调用 ${name}`
}

function toolDetail(block: ChatToolBlock): string {
  const paths = toolFilePaths(block)
  if (paths.length) return paths.join('、')
  for (const key of [
    'query',
    'pattern',
    'command',
    'cmd',
    'commandLine',
    'path',
    'file_path',
    'filePath',
    'code',
  ]) {
    const value = block.toolInput?.[key]
    if (typeof value === 'string' && value.trim()) return firstLine(value.trim())
  }
  return readableToolName(block.toolName)
}

function toolFilePaths(block: ChatToolBlock): string[] {
  const input = block.toolInput
  if (!input) return []
  for (const key of [
    'file_path',
    'filePath',
    'filepath',
    'path',
    'file',
    'filename',
    'target_file',
    'targetFile',
    'notebook_path',
    'notebookPath',
  ]) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return [value.trim()]
  }
  const patch = ['patch', 'input', 'arguments', 'content'].find(
    key => typeof input[key] === 'string'
  )
  const patchText = patch ? input[patch] : undefined
  if (typeof patchText !== 'string') return []
  const paths = new Set<string>()
  for (const line of patchText.split('\n')) {
    const match = line.match(/^\*\*\* (?:Add|Delete|Update) File:\s*(.+)$/)
    if (match?.[1]?.trim()) paths.add(match[1].trim())
  }
  return [...paths]
}

function readableToolName(name: string): string {
  return (name.split(/\.|__/).filter(Boolean).at(-1) ?? name).replaceAll('_', ' ')
}

function firstLine(value: string): string {
  const line = value.split('\n')[0] ?? value
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

function isContextCompactionName(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  const suffix = normalized.split(/__|\./).at(-1)
  return suffix === 'context_compaction' || suffix === 'contextcompaction'
}

const styles = StyleSheet.create({
  timeline: { marginBottom: 10, gap: 8 },
  narrativeSegment: { gap: 8 },
  toolSegment: { marginBottom: 2 },
  segmentHeader: {
    minHeight: 32,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  segmentTitle: { flexShrink: 1 },
  segmentDetails: { gap: 8, paddingTop: 3 },
  livePreview: {
    marginLeft: 7,
    paddingLeft: 12,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(128,128,128,0.38)',
  },
  processingStats: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  processingStat: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  completedTimeline: {
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.38)',
  },
  completedHeader: {
    minHeight: 34,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  completedLabel: { opacity: 0.62 },
  completedContent: { gap: 8, paddingTop: 2 },
  activityGroup: { marginBottom: 2 },
  activityRow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 32,
    gap: 7,
  },
  activityLabel: { flexShrink: 1 },
  activityDetails: {
    marginLeft: 9,
    paddingLeft: 14,
    borderLeftWidth: StyleSheet.hairlineWidth,
    gap: 6,
    paddingVertical: 4,
  },
  activityDetailRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  standaloneTool: { marginBottom: 2 },
  fileActivity: { gap: 4 },
  fileActivityRow: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 7 },
  fileActivityLabel: { flex: 1 },
  fileStats: { flexDirection: 'row', gap: 7 },
  additions: { color: '#00a86b' },
  deletions: { color: '#ef4444' },
  generatedImageGallery: { width: '100%', gap: 10, marginBottom: 12 },
  generatedImage: { width: '100%', height: 280, borderRadius: 12 },
  generatedImagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 16,
  },
  contextCompaction: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 4 },
  contextDivider: { height: StyleSheet.hairlineWidth, flex: 1 },
  contextLabel: { flexShrink: 1, fontWeight: '600' },
  error: { marginTop: 4 },
})
