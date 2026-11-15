import { useMemo } from 'react'
import {
  EnrichedMarkdownText,
  type AccessibilityLabels,
  type MarkdownStyle,
} from 'react-native-enriched-markdown'
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { useMobileFilePreview } from './files/FilePreviewContext'
import {
  classifyMarkdownLink,
  extractMarkdownLinks,
} from '../../../packages/collaboration/src/markdown/assistantMarkdownLinks'

interface AssistantMarkdownProps {
  children: string
  muted?: boolean
  streaming?: boolean
}

const ACCESSIBILITY_LABELS: AccessibilityLabels = {
  list: {
    bulletPoint: '项目符号',
    nestedBulletPoint: '嵌套项目符号',
    orderedItem: '列表第 {n} 项',
    nestedOrderedItem: '嵌套列表第 {n} 项',
  },
  blockquote: { quote: '引用', nestedQuote: '嵌套引用' },
  table: { row: '第 {n} 行：{content}' },
  rotor: { headings: '标题', links: '链接', images: '图片' },
}

const MARKDOWN_FLAGS = { latexMath: false } as const
const STREAMING_CONFIG = { tableMode: 'progressive', codeBlockMode: 'progressive' } as const

export function AssistantMarkdown({
  children,
  muted = false,
  streaming = false,
}: AssistantMarkdownProps) {
  const theme = useTheme()
  const filePreview = useMobileFilePreview()
  const imageFileLinks = useMemo(() => {
    const images = new Map<string, { href: string; title: string }>()
    for (const link of extractMarkdownLinks(children)) {
      const target = classifyMarkdownLink(link.href)
      if (
        target.kind === 'file' &&
        /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)(?:[?#]|$)/i.test(target.path)
      )
        images.set(link.href, link)
    }
    return [...images.values()]
  }, [children])
  const markdownStyle = useMemo<MarkdownStyle>(() => {
    const textColor = muted ? theme.colors.onSurfaceVariant : theme.colors.onBackground
    const subtleSurface = theme.colors.elevation.level2
    return {
      paragraph: {
        color: textColor,
        fontSize: muted ? 15 : 17,
        lineHeight: muted ? 23 : 27,
        marginTop: 0,
        marginBottom: muted ? 8 : 12,
      },
      h1: {
        color: textColor,
        fontSize: muted ? 18 : 22,
        lineHeight: muted ? 26 : 30,
        fontWeight: '600',
        marginTop: 8,
        marginBottom: 12,
      },
      h2: {
        color: textColor,
        fontSize: muted ? 17 : 20,
        lineHeight: muted ? 25 : 28,
        fontWeight: '600',
        marginTop: 8,
        marginBottom: 10,
      },
      h3: {
        color: textColor,
        fontSize: muted ? 16 : 18,
        lineHeight: muted ? 24 : 26,
        fontWeight: '600',
        marginTop: 6,
        marginBottom: 8,
      },
      h4: { color: textColor, fontSize: 17, lineHeight: 25, fontWeight: '600' },
      h5: { color: textColor, fontSize: 16, lineHeight: 24, fontWeight: '600' },
      h6: {
        color: theme.colors.onSurfaceVariant,
        fontSize: 15,
        lineHeight: 23,
        fontWeight: '600',
      },
      strong: { color: textColor },
      em: { color: textColor },
      list: {
        color: textColor,
        fontSize: muted ? 15 : 17,
        lineHeight: muted ? 23 : 27,
        marginTop: 0,
        marginBottom: muted ? 8 : 12,
        marginLeft: 20,
        markerMinWidth: 16,
        gapWidth: 8,
        itemSpacing: muted ? 2 : 6,
        bulletSize: muted ? 4 : 5,
        bulletColor: theme.colors.onSurfaceVariant,
        markerColor: theme.colors.onSurfaceVariant,
      },
      code: {
        color: theme.colors.onSurface,
        backgroundColor: subtleSurface,
        borderColor: theme.colors.outlineVariant,
        fontSize: muted ? 14 : 15,
      },
      codeBlock: {
        color: theme.colors.onSurface,
        backgroundColor: subtleSurface,
        borderColor: theme.colors.outlineVariant,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 10,
        padding: 12,
        fontSize: 14,
        lineHeight: 21,
        marginTop: 2,
        marginBottom: 14,
        syntaxColors: theme.dark
          ? {
              keyword: '#c792ea',
              string: '#c3e88d',
              number: '#f78c6c',
              constant: '#ffcb6b',
              comment: '#8a9aa9',
              function: '#82aaff',
              type: '#ffcb6b',
              property: '#89ddff',
              tag: '#f07178',
              attribute: '#c3e88d',
            }
          : {
              keyword: '#7c3aed',
              string: '#15803d',
              number: '#c2410c',
              constant: '#a16207',
              comment: '#64748b',
              function: '#1d4ed8',
              type: '#a16207',
              property: '#0369a1',
              tag: '#be123c',
              attribute: '#15803d',
            },
      },
      blockquote: {
        color: theme.colors.onSurfaceVariant,
        borderColor: theme.colors.outline,
        borderWidth: 3,
        gapWidth: 12,
        backgroundColor: theme.colors.elevation.level1,
        borderRadius: 8,
        padding: 10,
        marginTop: 0,
        marginBottom: 12,
        fontSize: muted ? 15 : 17,
        lineHeight: muted ? 23 : 27,
      },
      link: { color: theme.colors.primary, underline: true },
      thematicBreak: {
        color: theme.colors.outlineVariant,
        height: StyleSheet.hairlineWidth,
        marginTop: 8,
        marginBottom: 14,
      },
      table: {
        color: textColor,
        fontSize: 15,
        lineHeight: 22,
        headerBackgroundColor: subtleSurface,
        headerTextColor: textColor,
        rowEvenBackgroundColor: theme.colors.background,
        rowOddBackgroundColor: theme.colors.elevation.level1,
        borderColor: theme.colors.outlineVariant,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 8,
        cellPaddingHorizontal: 10,
        cellPaddingVertical: 8,
        marginBottom: 14,
      },
      taskList: {
        checkedColor: theme.colors.primary,
        borderColor: theme.colors.outline,
        checkmarkColor: theme.colors.onPrimary,
        checkedTextColor: theme.colors.onSurfaceVariant,
        checkboxSize: 17,
        checkboxBorderRadius: 4,
      },
      image: { maxHeight: 320, resizeMode: 'contain', borderRadius: 10, marginBottom: 14 },
    }
  }, [muted, theme.colors, theme.dark])

  return (
    <>
      <EnrichedMarkdownText
        accessibilityLabels={ACCESSIBILITY_LABELS}
        containerStyle={styles.container}
        enableTaskListItemToggle={false}
        flavor="github"
        lineBreakStrategyIOS="standard"
        markdown={children}
        markdownStyle={markdownStyle}
        md4cFlags={MARKDOWN_FLAGS}
        onLinkPress={({ url }) => {
          if (filePreview) return filePreview.openLink(url)
          if (!/^(https?:|mailto:|tel:)/i.test(url)) {
            Alert.alert('无法打开文件', '当前页面没有可用的文件工作空间。')
            return
          }
          void Linking.openURL(url).catch(error =>
            Alert.alert('无法打开链接', error instanceof Error ? error.message : String(error))
          )
        }}
        selectable={false}
        streamingAnimation={streaming}
        streamingConfig={STREAMING_CONFIG}
        testID="assistant-markdown"
        textBreakStrategy="highQuality"
        writingDirection="first-strong"
      />
      {imageFileLinks.length ? (
        <View style={styles.imageLinks}>
          {imageFileLinks.map((link, index) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`预览图片 ${link.title}`}
              disabled={!filePreview?.target}
              key={link.href}
              onPress={() => filePreview?.openLink(link.href)}
              style={[styles.imageLink, { backgroundColor: theme.colors.elevation.level1 }]}
              testID={`markdown-image-preview-${index}`}
            >
              <Text numberOfLines={2}>预览图片 · {link.title}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  container: { width: '100%' },
  imageLinks: { gap: 8, marginBottom: 12 },
  imageLink: { borderRadius: 10, padding: 12 },
})
