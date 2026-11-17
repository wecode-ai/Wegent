import { Pressable, StyleSheet, View } from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'
import type { ConversationItem } from '@/types/runtime'
import { ConversationMenu, type ConversationMenuActions } from './ConversationMenu'
import { SwipeArchiveRow } from './SwipeArchiveRow'

export function ConversationListRow({
  conversation,
  selected,
  actions,
  open,
  onOpen,
  onClose,
  onSwipeStart,
  onSelect,
}: {
  conversation: ConversationItem
  selected: boolean
  actions?: ConversationMenuActions
  open: boolean
  onOpen: () => void
  onClose: () => void
  onSwipeStart: () => void
  onSelect: (conversation: ConversationItem) => void
}) {
  const theme = useTheme()
  const styles = StyleSheet.create({
    row: { minHeight: 48, marginHorizontal: 20, borderRadius: 12, overflow: 'hidden' },
    projectRow: { marginLeft: 52 },
    content: {
      minHeight: 48,
      width: '100%',
      paddingHorizontal: 4,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    title: { flex: 1, color: theme.colors.onBackground, fontSize: 17, fontWeight: '400' },
    selected: { backgroundColor: theme.colors.surfaceVariant },
    pressed: { backgroundColor: theme.colors.surfaceVariant },
  })
  const openConversation = () => onSelect(conversation)
  const renderPressable = (
    onPress: () => void,
    onLongPress?: () => void,
    disabled = false,
    onArchive?: () => void
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={conversation.title}
      accessibilityState={{ selected, disabled }}
      accessibilityActions={onArchive ? [{ name: 'archive', label: '归档' }] : undefined}
      onAccessibilityAction={event => {
        if (event.nativeEvent.actionName === 'archive' && !disabled) onArchive?.()
      }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [pressed && styles.pressed]}
      testID={`conversation-${conversation.address.taskId}`}
    >
      <View style={styles.content}>
        <Text numberOfLines={1} style={styles.title} variant="titleMedium">
          {conversation.title}
        </Text>
        {conversation.running ? (
          <ActivityIndicator color={theme.colors.onSurfaceVariant} size={22} />
        ) : null}
      </View>
    </Pressable>
  )
  return (
    <View
      style={[
        styles.row,
        conversation.projectName && styles.projectRow,
        selected && styles.selected,
      ]}
    >
      {actions ? (
        <ConversationMenu
          {...actions}
          address={conversation.address}
          title={conversation.title}
          listItem
          onAction={onClose}
          testID={`conversation-menu-${conversation.address.deviceId}-${conversation.address.taskId}`}
          renderRow={({ disabled, onLongPress, onArchive }) => (
            <SwipeArchiveRow
              open={open}
              disabled={disabled}
              selected={selected}
              onOpen={onOpen}
              onClose={onClose}
              onSwipeStart={onSwipeStart}
              onPress={openConversation}
              onArchive={onArchive}
              testID={`conversation-swipe-${conversation.address.deviceId}-${conversation.address.taskId}`}
            >
              {onPress => renderPressable(onPress, onLongPress, disabled, onArchive)}
            </SwipeArchiveRow>
          )}
        />
      ) : (
        renderPressable(openConversation)
      )}
    </View>
  )
}
