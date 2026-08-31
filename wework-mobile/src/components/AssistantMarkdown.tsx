import { useMemo } from 'react'
import { Image, Platform, StyleSheet, Text } from 'react-native'
import Markdown, { type RenderRules } from 'react-native-markdown-display'
import { useTheme } from 'react-native-paper'

interface AssistantMarkdownProps {
  children: string
  muted?: boolean
}

export function AssistantMarkdown({ children, muted = false }: AssistantMarkdownProps) {
  const theme = useTheme()
  const rules = useMemo<RenderRules>(
    () => ({
      image: (node, _children, _parents, styles) => {
        const source = String(node.attributes.src ?? '')
        const alt = String(node.attributes.alt ?? '图片')
        if (!isRenderableImageSource(source)) {
          return (
            <Text key={node.key} style={styles.text}>
              {alt}
            </Text>
          )
        }
        return (
          <Image
            accessibilityLabel={alt}
            accessible
            key={node.key}
            resizeMode="contain"
            source={{ uri: source }}
            style={styles.image}
          />
        )
      },
    }),
    []
  )
  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: {
          color: theme.colors.onBackground,
          fontSize: muted ? 15 : 17,
          lineHeight: muted ? 23 : 27,
          opacity: muted ? 0.72 : 1,
        },
        paragraph: { marginTop: 0, marginBottom: 12 },
        heading1: { fontSize: 20, lineHeight: 28, fontWeight: '600', marginBottom: 12 },
        heading2: { fontSize: 18, lineHeight: 26, fontWeight: '600', marginBottom: 10 },
        heading3: { fontSize: 17, lineHeight: 25, fontWeight: '600', marginBottom: 8 },
        heading4: { fontSize: 17, lineHeight: 25, fontWeight: '600', marginBottom: 8 },
        heading5: { fontSize: 16, lineHeight: 24, fontWeight: '600', marginBottom: 7 },
        heading6: {
          color: theme.colors.onSurfaceVariant,
          fontSize: 15,
          lineHeight: 23,
          fontWeight: '600',
          marginBottom: 7,
        },
        strong: { fontWeight: '600' },
        em: { fontStyle: 'italic' },
        s: { textDecorationLine: 'line-through' },
        hr: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.outlineVariant },
        blockquote: {
          borderColor: theme.colors.outline,
          borderLeftWidth: 3,
          marginLeft: 0,
          marginBottom: 12,
          paddingLeft: 12,
          opacity: 0.8,
        },
        bullet_list: { marginBottom: 12 },
        ordered_list: { marginBottom: 12 },
        list_item: { marginBottom: 2 },
        bullet_list_icon: { marginLeft: 4, marginRight: 10, fontSize: 19, lineHeight: 27 },
        bullet_list_content: { flex: 1 },
        ordered_list_icon: { marginLeft: 2, marginRight: 8, lineHeight: 27 },
        ordered_list_content: { flex: 1 },
        code_inline: {
          color: theme.colors.onSurfaceVariant,
          backgroundColor: theme.colors.surfaceVariant,
          borderRadius: 4,
          paddingHorizontal: 5,
          paddingVertical: 1,
          fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
          fontSize: muted ? 14 : 15,
        },
        code_block: {
          color: theme.colors.onSurfaceVariant,
          backgroundColor: theme.colors.surfaceVariant,
          borderColor: theme.colors.outlineVariant,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 10,
          padding: 12,
          fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
          fontSize: 14,
          lineHeight: 21,
        },
        fence: {
          color: theme.colors.onSurfaceVariant,
          backgroundColor: theme.colors.surfaceVariant,
          borderColor: theme.colors.outlineVariant,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 10,
          padding: 12,
          fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
          fontSize: 14,
          lineHeight: 21,
        },
        table: {
          borderColor: theme.colors.outlineVariant,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 6,
          marginBottom: 14,
        },
        tr: {
          borderBottomColor: theme.colors.outlineVariant,
          borderBottomWidth: StyleSheet.hairlineWidth,
          flexDirection: 'row',
        },
        th: { flex: 1, padding: 7, backgroundColor: theme.colors.surfaceVariant },
        td: { flex: 1, padding: 7 },
        link: { color: theme.colors.primary, textDecorationLine: 'underline' },
        image: { width: '100%', height: 240, borderRadius: 10 },
      }),
    [muted, theme.colors]
  )

  return (
    <Markdown rules={rules} style={styles}>
      {children}
    </Markdown>
  )
}

function isRenderableImageSource(source: string): boolean {
  return /^(https?:\/\/|data:image\/)/i.test(source)
}
