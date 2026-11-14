import type { GlassColorScheme } from 'expo-glass-effect'
import { StatusBar } from 'expo-status-bar'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, StyleSheet, useColorScheme } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { Dialog, PaperProvider, Portal, Snackbar, Text, useTheme } from 'react-native-paper'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

import { useWegentAuth } from '@/auth/useWegentAuth'
import { AuthorizationScreen } from '@/components/AuthorizationScreen'
import { ConversationListScreen } from '@/components/ConversationListScreen'
import { ConversationScreen } from '@/components/ConversationScreen'
import { LiquidGlassButton } from '@/components/LiquidGlass'
import { ModelPickerScreen } from '@/components/ModelPickerDialog'
import { ProjectDialog } from '@/components/ProjectDialog'
import { FilePreviewProvider } from '@/components/files/FilePreviewProvider'
import { useMobileRuntime } from '@/hooks/useMobileRuntime'
import type { RuntimeSessionConfig } from '@/services/backendConfig'
import { recordChatLayoutDiagnostic } from '@/services/chatLayoutDiagnostics'
import { darkTheme, lightTheme } from '@/theme'

type RuntimeStackParamList = {
  conversationList: undefined
  conversation: undefined
  modelPicker: undefined
}

const RuntimeStack = createNativeStackNavigator<RuntimeStackParamList>()

export default function App() {
  useEffect(() => {
    recordChatLayoutDiagnostic(JSON.stringify({ event: 'appStart', timestamp: Date.now() }))
  }, [])
  const auth = useWegentAuth()
  const colorScheme = useColorScheme()
  const theme = colorScheme === 'dark' ? darkTheme : lightTheme

  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <PaperProvider theme={theme}>
          <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
          {auth.status === 'authenticated' && auth.config ? (
            <RuntimeApplication
              key={`${auth.config.apiBaseUrl}:${auth.user?.id ?? 0}`}
              config={auth.config}
              onLogout={auth.logout}
              userId={auth.user?.id ?? 0}
              userLabel={auth.user?.full_name || auth.user?.user_name || ''}
            />
          ) : (
            <AuthorizationScreen
              backendUrl={auth.backendUrl}
              error={auth.error}
              onBackendUrlChange={auth.setBackendUrl}
              onAuthorize={auth.login}
              status={auth.status}
            />
          )}
        </PaperProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}

function RuntimeApplication({
  config,
  onLogout,
  userId,
  userLabel,
}: {
  config: RuntimeSessionConfig
  onLogout: () => Promise<void>
  userId: number
  userLabel: string
}) {
  const runtime = useMobileRuntime(config, userId)
  const theme = useTheme()
  const glassColorScheme: GlassColorScheme = theme.dark ? 'dark' : 'light'
  const [projectVisible, setProjectVisible] = useState(false)
  const [settingsVisible, setSettingsVisible] = useState(false)
  const [search, setSearch] = useState('')
  const [conversationEntryRevision, setConversationEntryRevision] = useState(0)
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const pendingComposerFocus = useRef(false)
  const openSettings = () => {
    Keyboard.dismiss()
    setSettingsVisible(true)
  }

  const workspaces = useMemo(
    () =>
      runtime.work.projects.flatMap(project =>
        project.deviceWorkspaces.map(workspace => ({
          projectName: project.project.name,
          workspace,
        }))
      ),
    [runtime.work.projects]
  )
  const isNewConversation = !runtime.currentAddress && runtime.messages.length === 0
  const selectedProjectName = useMemo(
    () =>
      workspaces.find(
        item =>
          item.workspace.deviceId === runtime.selectedWorkspace?.deviceId &&
          item.workspace.workspacePath === runtime.selectedWorkspace.workspacePath
      )?.projectName ?? null,
    [runtime.selectedWorkspace, workspaces]
  )
  return (
    <>
      <FilePreviewProvider
        api={runtime.api}
        apiBaseUrl={config.apiBaseUrl}
        target={runtime.fileTarget}
      >
        <NavigationContainer>
          <RuntimeStack.Navigator screenOptions={{ headerShown: false }}>
            <RuntimeStack.Screen name="conversationList" options={{ animation: 'none' }}>
              {({ navigation }) => (
                <ConversationListScreen
                  userLabel={userLabel}
                  allDevicesSelected={runtime.allDevicesSelected}
                  conversations={runtime.conversations}
                  currentAddress={runtime.currentAddress}
                  devices={runtime.devices}
                  loading={runtime.loading}
                  onNewConversation={workspace => {
                    pendingComposerFocus.current = true
                    runtime.startNewConversation(workspace)
                    navigation.navigate('conversation')
                  }}
                  onNewProject={() => {
                    Keyboard.dismiss()
                    setProjectVisible(true)
                  }}
                  onSearch={setSearch}
                  onRefresh={runtime.refresh}
                  onSelectAllDevices={runtime.selectAllDevices}
                  onSelectConversation={item => {
                    pendingComposerFocus.current = false
                    setConversationEntryRevision(current => current + 1)
                    void runtime.openConversation(item)
                    navigation.navigate('conversation')
                  }}
                  onSelectDevice={deviceId => {
                    runtime.selectDevice(deviceId)
                  }}
                  onSettings={openSettings}
                  search={search}
                  refreshing={runtime.refreshing}
                  selectedDeviceId={runtime.selectedDeviceId}
                  workspaces={workspaces}
                />
              )}
            </RuntimeStack.Screen>
            <RuntimeStack.Screen
              name="conversation"
              listeners={{
                transitionEnd: event => {
                  if (event.data.closing || !pendingComposerFocus.current) return
                  pendingComposerFocus.current = false
                  setComposerFocusRequest(current => current + 1)
                },
              }}
              options={{
                animation: 'slide_from_right',
                animationMatchesGesture: true,
                gestureDirection: 'horizontal',
                gestureEnabled: true,
              }}
            >
              {({ navigation }) => (
                <SafeAreaView
                  edges={['left', 'right']}
                  style={[styles.app, { backgroundColor: theme.colors.background }]}
                >
                  <ConversationScreen
                    composerFocusRequest={isNewConversation ? composerFocusRequest : 0}
                    currentAddress={runtime.currentAddress}
                    currentTitle={runtime.currentTitle}
                    devices={runtime.devices}
                    entryRevision={conversationEntryRevision}
                    gitRef={runtime.gitRef}
                    isNew={isNewConversation}
                    hasMoreMessagesBefore={runtime.hasMoreMessagesBefore}
                    loading={runtime.conversationLoading}
                    loadingMoreMessagesBefore={runtime.loadingMoreMessagesBefore}
                    messages={runtime.messages}
                    model={runtime.selectedModel}
                    modelOptions={runtime.selectedModelOptions}
                    permissionMode={runtime.permissionMode}
                    onBack={navigation.goBack}
                    onLoadApps={runtime.loadComposerApps}
                    onLoadMoreMessagesBefore={runtime.loadMoreMessagesBefore}
                    onMore={openSettings}
                    onNewConversation={() => {
                      runtime.startNewConversation(runtime.selectedWorkspace ?? undefined)
                      setComposerFocusRequest(current => current + 1)
                    }}
                    onOpenAdvancedModel={() => navigation.navigate('modelPicker')}
                    onSelectDevice={runtime.selectDevice}
                    onSelectModel={runtime.selectModel}
                    onSelectPermissionMode={runtime.selectPermissionMode}
                    onSelectWorkspace={runtime.selectWorkspace}
                    onSend={runtime.send}
                    onStop={runtime.stop}
                    onRequestUserInputSubmit={runtime.respondToUserInput}
                    onRequestUserInputSkip={runtime.skipUserInput}
                    onUploadAttachment={runtime.uploadAttachment}
                    running={runtime.running}
                    selectedDeviceId={runtime.selectedDeviceId}
                    selectedProjectName={selectedProjectName}
                    selectedWorkspace={runtime.selectedWorkspace}
                    sending={runtime.sending}
                    stopping={runtime.stopping}
                    workspaces={workspaces}
                  />
                </SafeAreaView>
              )}
            </RuntimeStack.Screen>
            <RuntimeStack.Screen
              name="modelPicker"
              options={{
                animation: 'fade',
                contentStyle: styles.transparentScreen,
                presentation: 'transparentModal',
              }}
            >
              {({ navigation }) => (
                <ModelPickerScreen
                  loading={runtime.modelsLoading}
                  error={runtime.modelsError}
                  onLoadModels={runtime.loadModels}
                  models={runtime.models}
                  onDismiss={navigation.goBack}
                  onSelect={runtime.selectModel}
                  selectedModel={runtime.selectedModel}
                  selectedOptions={runtime.selectedModelOptions}
                />
              )}
            </RuntimeStack.Screen>
          </RuntimeStack.Navigator>
        </NavigationContainer>
      </FilePreviewProvider>

      <ProjectDialog
        devices={runtime.devices}
        onCreate={runtime.createProject}
        onDismiss={() => setProjectVisible(false)}
        selectedDeviceId={runtime.selectedDeviceId}
        visible={projectVisible}
      />

      <Portal>
        <Dialog onDismiss={() => setSettingsVisible(false)} visible={settingsVisible}>
          <Dialog.Title>连接设置</Dialog.Title>
          <Dialog.Content style={styles.settingsContent}>
            <Text variant="labelLarge">Backend</Text>
            <Text selectable variant="bodyMedium">
              {config.backendUrl}
            </Text>
            {userLabel ? (
              <Text style={styles.settingsUser} variant="bodyMedium">
                {userLabel}
              </Text>
            ) : null}
            <Text style={styles.settingsHint} variant="bodySmall">
              登录凭据通过设备 P-256 密钥绑定，并保存在系统钥匙串或 Android Keystore 中。
            </Text>
          </Dialog.Content>
          <Dialog.Actions style={styles.settingsActions}>
            <LiquidGlassButton
              colorScheme={glassColorScheme}
              contentStyle={styles.settingsActionContent}
              fallbackStyle={{
                backgroundColor: theme.colors.surfaceVariant,
                borderColor: theme.colors.outlineVariant,
              }}
              onPress={() => setSettingsVisible(false)}
              style={styles.settingsActionGlass}
              testID="close-settings"
            >
              <Text variant="labelLarge">关闭</Text>
            </LiquidGlassButton>
            <LiquidGlassButton
              colorScheme={glassColorScheme}
              contentStyle={styles.settingsActionContent}
              fallbackStyle={{
                backgroundColor: 'rgba(255, 69, 58, 0.18)',
                borderColor: 'rgba(255, 105, 97, 0.52)',
              }}
              onPress={() => {
                setSettingsVisible(false)
                void onLogout()
              }}
              style={styles.settingsActionGlass}
              testID="disconnect-backend"
              tintColor="rgba(255, 69, 58, 0.3)"
            >
              <Text style={{ color: theme.colors.error }} variant="labelLarge">
                退出登录
              </Text>
            </LiquidGlassButton>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar
        action={{ label: '重试', onPress: () => void runtime.refresh() }}
        duration={5000}
        onDismiss={runtime.clearError}
        visible={Boolean(runtime.error)}
      >
        {runtime.error}
      </Snackbar>
    </>
  )
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  transparentScreen: { backgroundColor: 'transparent' },
  settingsContent: { gap: 8 },
  settingsUser: { marginTop: 4 },
  settingsHint: { opacity: 0.54, marginTop: 8 },
  settingsActions: { gap: 8 },
  settingsActionGlass: { minWidth: 88, height: 42, borderRadius: 21 },
  settingsActionContent: {
    width: '100%',
    height: '100%',
    paddingHorizontal: 18,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
