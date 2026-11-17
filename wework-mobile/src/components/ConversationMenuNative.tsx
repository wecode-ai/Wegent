import {
  DropdownMenu,
  DropdownMenuItem,
  HorizontalDivider,
  Host,
  RNHostView,
  Text,
} from '@expo/ui/jetpack-compose'
import { testID } from '@expo/ui/jetpack-compose/modifiers'
import { Fragment, useState } from 'react'
import { Pressable, View } from 'react-native'
import { useTheme } from 'react-native-paper'
import type { ConversationMenuNativeProps } from './ConversationMenuNative.types'

export function ConversationMenuNative(props: ConversationMenuNativeProps) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const row = props.trigger === 'longPress'
  const open = () => {
    if (!props.disabled) setExpanded(true)
  }
  return (
    <Host
      colorScheme={props.colorScheme}
      ignoreSafeAreaKeyboardInsets
      matchContents={row ? { vertical: true } : true}
      style={
        row ? { width: '100%', minHeight: 48 } : { width: props.width, height: props.height ?? 44 }
      }
      modifiers={[testID(props.testID ?? 'conversation-menu')]}
    >
      <DropdownMenu
        expanded={expanded}
        onDismissRequest={() => setExpanded(false)}
        properties={{ clippingEnabled: false }}
      >
        <DropdownMenu.Trigger>
          <RNHostView matchContents={row ? { vertical: true } : true}>
            {typeof props.children === 'function' ? (
              <View style={{ width: '100%' }} testID={props.triggerTestID ?? 'more-actions'}>
                {props.children({
                  disabled: props.disabled,
                  onLongPress: row ? open : undefined,
                })}
              </View>
            ) : (
              <Pressable
                accessibilityLabel={props.accessibilityLabel ?? '更多'}
                accessibilityRole="button"
                accessibilityState={{ disabled: props.disabled, expanded }}
                disabled={props.disabled}
                onPress={row ? undefined : open}
                onLongPress={row ? open : undefined}
                testID={props.triggerTestID ?? 'more-actions'}
              >
                {props.children}
              </Pressable>
            )}
          </RNHostView>
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          {props.actions.map((action, index) => (
            <Fragment key={action.id}>
              {index > 0 && props.actions[index - 1]?.section !== action.section ? (
                <HorizontalDivider />
              ) : null}
              <DropdownMenuItem
                elementColors={action.destructive ? { textColor: theme.colors.error } : undefined}
                enabled={!action.disabled}
                modifiers={[testID(action.id)]}
                onClick={() => {
                  if (props.disabled || action.disabled) return
                  setExpanded(false)
                  props.onSelect(action.id)
                }}
              >
                <DropdownMenuItem.Text>
                  <Text>{action.title}</Text>
                </DropdownMenuItem.Text>
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  )
}
