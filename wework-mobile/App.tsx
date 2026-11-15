import { StatusBar } from 'expo-status-bar'
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, StyleSheet, useColorScheme } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { Dialog, PaperProvider, Portal, Text, useTheme } from 'react-native-paper'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

import { useWegentAuth } from '@/auth/useWegentAuth'
import type { WegentAuthState } from '@/auth/useWegentAuth'
import { ConversationListScreen } from '@/components/ConversationListScreen'
import { ConversationScreen } from '@/components/ConversationScreen'
import { ModelPickerScreen } from '@/components/ModelPickerDialog'
import { ProjectDialog } from '@/components/ProjectDialog'
import { FilePreviewProvider } from '@/components/files/FilePreviewProvider'
import { useMobileRuntime } from '@/hooks/useMobileRuntime'
import { useLocalRuntime } from '@/hooks/useLocalRuntime'
import {
  SettingsScreen,
  LocalExecutionScreen,
  BackendLoginScreen,
} from '@/components/SettingsScreen'
import {
  PhoneModelsScreen,
  PhoneModelEditorScreen,
  CodexAccountScreen,
} from '@/components/PhoneModelsScreen'
import { phoneLocalModels } from '@/services/phoneLocalModels'
import { recordChatLayoutDiagnostic } from '@/services/chatLayoutDiagnostics'
import { darkTheme, lightTheme } from '@/theme'
import { conversationPinTarget } from '@/domain/conversationActions'
import { NativeErrorAlert } from '@/components/errors/NativeErrorAlert'

type RuntimeStackParamList = {
  conversationList: undefined
  conversation: undefined
  modelPicker: undefined
  settings: undefined
  localExecution: undefined
  localModels: undefined
  modelEditor: { modelId?: string } | undefined
  codexAccount: undefined
  backendLogin: undefined
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
          <RuntimeApplication auth={auth} />
        </PaperProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}

function RuntimeApplication({ auth }: { auth: WegentAuthState }) {
  const config = auth.config
  const userId = auth.user?.id ?? 0
  const userLabel = auth.user?.full_name || auth.user?.user_name || ''
  const local = useLocalRuntime()
  const runtime = useMobileRuntime(
    config,
    userId,
    local.runtime ? { runtime: local.runtime, models: phoneLocalModels } : undefined
  )
  const refreshLocal = useCallback(async () => {
    await runtime.loadLocalModels()
  }, [runtime.loadLocalModels])
  const theme = useTheme()
  const [projectVisible, setProjectVisible] = useState(false)
  const [search, setSearch] = useState('')
  const [conversationEntryRevision, setConversationEntryRevision] = useState(0)
  const conversationEntryRevisionRef = useRef(conversationEntryRevision)
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const pendingComposerFocus = useRef<number | null>(null)
  const clearComposerFocus = useCallback(() => {
    pendingComposerFocus.current = null
    setComposerFocusRequest(0)
  }, [])
  const handleComposerFocus = useCallback((request: number) => {
    setComposerFocusRequest(current => (current === request ? 0 : current))
  }, [])
  const enterConversation = () => {
    clearComposerFocus()
    conversationEntryRevisionRef.current += 1
    setConversationEntryRevision(conversationEntryRevisionRef.current)
    return conversationEntryRevisionRef.current
  }
  const openSettings = (navigation: { navigate: (name: 'settings') => void }) => {
    Keyboard.dismiss()
    navigation.navigate('settings')
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
  const pinTarget = runtime.currentAddress
    ? conversationPinTarget(runtime.work, runtime.currentAddress)
    : null
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
        apiBaseUrl={config?.apiBaseUrl ?? ''}
        backendSession={config ? `${config.apiBaseUrl}\0${userId}` : null}
        target={runtime.fileTarget}
      >
        <NavigationContainer>
          <RuntimeStack.Navigator
            screenOptions={{ headerShown: false, keyboardHandlingEnabled: true }}
          >
            <RuntimeStack.Screen name="conversationList" options={{ animation: 'none' }}>
              {({ navigation }) => (
                <ConversationListScreen
                  userLabel={userLabel}
                  connectionError={runtime.connectionError}
                  showDeviceFilters={Boolean(config && auth.user)}
                  allDevicesSelected={runtime.allDevicesSelected}
                  conversations={runtime.conversations}
                  currentAddress={runtime.currentAddress}
                  devices={runtime.devices}
                  loading={runtime.loading}
                  onNewConversation={workspace => {
                    pendingComposerFocus.current = enterConversation()
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
                    enterConversation()
                    void runtime.openConversation(item)
                    navigation.navigate('conversation')
                  }}
                  onSelectDevice={deviceId => {
                    runtime.selectDevice(deviceId)
                  }}
                  onSettings={() => openSettings(navigation)}
                  search={search}
                  refreshing={runtime.refreshing}
                  selectedDeviceId={runtime.selectedDeviceId}
                  workspaces={workspaces}
                />
              )}
            </RuntimeStack.Screen>
            <RuntimeStack.Screen
              name="conversation"
              listeners={({ navigation }) => ({
                blur: clearComposerFocus,
                transitionStart: event => {
                  if (event.data.closing) clearComposerFocus()
                },
                transitionEnd: event => {
                  const request = pendingComposerFocus.current
                  if (
                    event.data.closing ||
                    !navigation.isFocused() ||
                    request === null ||
                    request !== conversationEntryRevisionRef.current
                  )
                    return
                  pendingComposerFocus.current = null
                  setComposerFocusRequest(request)
                },
              })}
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
                    api={runtime.api}
                    composerFocusRequest={isNewConversation ? composerFocusRequest : 0}
                    onComposerFocusHandled={handleComposerFocus}
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
                    conversationActions={{
                      onSettings: () => openSettings(navigation),
                      threadId: pinTarget?.threadId ?? null,
                      canPin: Boolean(pinTarget),
                      pinned: pinTarget?.pinned ?? false,
                      onPin: async () => {
                        if (runtime.currentAddress)
                          await runtime.setConversationPinned(
                            runtime.currentAddress,
                            !pinTarget?.pinned
                          )
                      },
                      onRename: async title => {
                        if (runtime.currentAddress)
                          await runtime.renameConversation(runtime.currentAddress, title)
                      },
                      onArchive: async () => {
                        if (!runtime.currentAddress) return
                        await runtime.archiveConversation(runtime.currentAddress)
                        if (
                          conversationEntryRevisionRef.current === conversationEntryRevision &&
                          navigation.isFocused()
                        )
                          navigation.goBack()
                      },
                    }}
                    onNewConversation={() => {
                      const request = enterConversation()
                      runtime.startNewConversation(runtime.selectedWorkspace ?? undefined)
                      setComposerFocusRequest(request)
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
            <RuntimeStack.Screen
              name="settings"
              options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
            >
              {({ navigation }) => (
                <SettingsScreen
                  auth={auth}
                  status={local.status}
                  localError={local.error}
                  onClose={navigation.goBack}
                  onModels={() => navigation.navigate('localModels')}
                  onExecution={() => navigation.navigate('localExecution')}
                  onBackend={() => navigation.navigate('backendLogin')}
                />
              )}
            </RuntimeStack.Screen>
            <RuntimeStack.Screen name="localModels">
              {({ navigation }) => (
                <PhoneModelsScreen
                  runtime={local.runtime}
                  status={local.status}
                  onBack={navigation.goBack}
                  onAdd={() => navigation.navigate('modelEditor')}
                  onEdit={id => navigation.navigate('modelEditor', { modelId: id })}
                  onAccount={() => navigation.navigate('codexAccount')}
                />
              )}
            </RuntimeStack.Screen>
            <RuntimeStack.Screen name="modelEditor">
              {({ navigation, route }) => (
                <PhoneModelEditorScreen
                  modelId={route?.params?.modelId}
                  runtime={local.runtime}
                  onBack={navigation.goBack}
                  onChanged={refreshLocal}
                />
              )}
            </RuntimeStack.Screen>
            <RuntimeStack.Screen name="codexAccount">
              {({ navigation }) => (
                <CodexAccountScreen
                  runtime={local.runtime}
                  status={local.status}
                  error={local.error}
                  onRetry={local.retry}
                  onBack={navigation.goBack}
                  onChanged={refreshLocal}
                />
              )}
            </RuntimeStack.Screen>
            <RuntimeStack.Screen name="localExecution">
              {({ navigation }) => (
                <LocalExecutionScreen
                  runtime={local.runtime}
                  status={local.status}
                  profiles={local.profiles}
                  onSelectProfile={local.selectProfile}
                  selectingProfile={local.selectingProfile}
                  error={local.error}
                  onRetry={local.retry}
                  onBack={navigation.goBack}
                  onChanged={refreshLocal}
                />
              )}
            </RuntimeStack.Screen>
            <RuntimeStack.Screen name="backendLogin">
              {({ navigation }) => <BackendLoginScreen auth={auth} onClose={navigation.goBack} />}
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

      <NativeErrorAlert
        error={runtime.error}
        onRetry={runtime.refresh}
        retryLabel="刷新"
        onDismiss={runtime.clearError}
      />
    </>
  )
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  transparentScreen: { backgroundColor: 'transparent' },
})
