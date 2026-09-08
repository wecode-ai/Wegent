window.__ModuleLoader__.load({
  id: '@wegent/dsh-app-wework',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { Fragment, createElement, useEffect, useRef, useState } = React
    const { createPortal } = require('react-dom')

    const APP_RUNTIME_READY_EVENT = 'wework:app-runtime-ready'
    const PLUGIN_BACKEND_PATH = '/wework/plugins/v1/rpc'
    const ROOT_PRIORITY = -100
    const CONTRIBUTION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
    const CONTEXT_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
    const SLOT_GROUP_DECLARATIONS = {
      'wework.internal.catalog': { kind: 'single', scope: 'root' },
      'wework.internal.shell': { kind: 'single', scope: 'root' },
      'wework.internal.workspace': { kind: 'single', scope: 'root' },
    }
    const SLOT_GROUPS = {
      'wework.internal.catalog': {
        'wework.action': { kind: 'list', scope: 'root' },
        'wework.app': { kind: 'list', scope: 'root' },
        'wework.plugins.action': { kind: 'list', scope: 'root' },
        'wework.project.create.section': { kind: 'list', scope: 'root' },
        'wework.route': { kind: 'list', scope: 'root' },
        'wework.runtime-profile.workspace-policy': { kind: 'list', scope: 'root' },
        'wework.settings.page': { kind: 'list', scope: 'root' },
        'wework.settings.section': { kind: 'list', scope: 'root' },
        'wework.sidebar.navigation': { kind: 'list', scope: 'root' },
      },
      'wework.internal.shell': {
        'wework.shell.after': { kind: 'list', scope: 'root' },
        'wework.shell.before': { kind: 'list', scope: 'root' },
        'wework.shell.overlay': { kind: 'list', scope: 'root' },
      },
      'wework.internal.workspace': {
        'wework.board.card.status': { kind: 'list', scope: 'root' },
        'wework.composer.action': { kind: 'list', scope: 'session-maybe' },
        'wework.environment.section': { kind: 'list', scope: 'session-maybe' },
        'wework.project.work.section': { kind: 'list', scope: 'session-maybe' },
        'wework.task.status': { kind: 'list', scope: 'root' },
        'wework.workspace.menu.section': { kind: 'list', scope: 'session-maybe' },
        'wework.workspace.bottom-panel.tab': { kind: 'list', scope: 'session-maybe' },
        'wework.workspace.sidebar.tab': { kind: 'list', scope: 'session-maybe' },
        'wework.workspace.tab': { kind: 'list', scope: 'session-maybe' },
        'wework.workspace.toolbar.action': { kind: 'list', scope: 'session-maybe' },
      },
    }
    const SLOT_DECLARATIONS = Object.freeze(Object.assign({}, ...Object.values(SLOT_GROUPS)))

    function requiredContributionId(value, label) {
      if (typeof value !== 'string' || !CONTRIBUTION_ID_PATTERN.test(value)) {
        throw new Error(`${label} must match ${CONTRIBUTION_ID_PATTERN}`)
      }
      return value
    }

    function requiredContextKey(value) {
      if (typeof value !== 'string' || !CONTEXT_KEY_PATTERN.test(value)) {
        throw new Error(`Context key must match ${CONTEXT_KEY_PATTERN}`)
      }
      return value
    }

    function requiredOwner(owner, label) {
      if (!owner || typeof owner.effect !== 'function') {
        throw new Error(`${label} requires a Cordis context owner`)
      }
      return owner
    }

    function freezeContribution(value) {
      return Object.freeze({ ...value })
    }

    function validateContribution(location, entry) {
      if (
        location === 'wework.workspace.bottom-panel.tab' &&
        (typeof entry.label !== 'string' || entry.label.trim() === '')
      ) {
        throw new Error('Bottom panel contribution label must be a non-empty string')
      }
    }

    function createContributionRegistry(kind, onChange) {
      const entries = new Map()

      return {
        register(owner, rawEntry) {
          requiredOwner(owner, `${kind} registration`)
          const entry = freezeContribution(rawEntry)
          const id = requiredContributionId(entry.id, `${kind} id`)
          if (entries.has(id)) throw new Error(`${kind} already registered: ${id}`)
          entries.set(id, entry)
          onChange()
          let disposed = false
          const dispose = () => {
            if (disposed) return
            disposed = true
            if (entries.get(id) !== entry) return
            entries.delete(id)
            onChange()
          }
          owner.effect(() => dispose, `wework-${kind}: ${id}`)
          return dispose
        },
        get(id) {
          return entries.get(id) ?? null
        },
        list() {
          return [...entries.values()]
        },
        clear() {
          if (entries.size === 0) return
          entries.clear()
          onChange()
        },
      }
    }

    function createContributionCatalog(onChange) {
      const locations = new Map()

      return Object.freeze({
        register(owner, rawLocation, rawEntry) {
          requiredOwner(owner, 'Contribution registration')
          const location = requiredContributionId(rawLocation, 'Contribution location')
          const entry = freezeContribution(rawEntry)
          const id = requiredContributionId(entry.id, 'Contribution id')
          validateContribution(location, entry)
          let entries = locations.get(location)
          if (!entries) {
            entries = new Map()
            locations.set(location, entries)
          }
          if (entries.has(id)) {
            throw new Error(`Contribution already registered: ${location}/${id}`)
          }
          entries.set(id, entry)
          onChange()
          let disposed = false
          const dispose = () => {
            if (disposed) return
            disposed = true
            if (entries.get(id) !== entry) return
            entries.delete(id)
            if (entries.size === 0) locations.delete(location)
            onChange()
          }
          owner.effect(() => dispose, `wework-contribution: ${location}/${id}`)
          return dispose
        },
        get(location, id) {
          return (
            locations
              .get(requiredContributionId(location, 'Contribution location'))
              ?.get(requiredContributionId(id, 'Contribution id')) ?? null
          )
        },
        list(location) {
          return [
            ...(locations
              .get(requiredContributionId(location, 'Contribution location'))
              ?.values() ?? []),
          ].sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
        },
        clear() {
          if (locations.size === 0) return
          locations.clear()
          onChange()
        },
      })
    }

    function createProviderRegistry(kind, requiredMethods, onChange) {
      const providers = new Map()

      return Object.freeze({
        register(owner, rawProvider) {
          requiredOwner(owner, `${kind} provider registration`)
          if (!rawProvider || typeof rawProvider !== 'object') {
            throw new Error(`${kind} provider must be an object`)
          }
          const provider = freezeContribution(rawProvider)
          const id = requiredContributionId(provider.id, `${kind} provider id`)
          for (const method of requiredMethods) {
            if (typeof provider[method] !== 'function') {
              throw new Error(`${kind} provider "${id}" requires ${method}()`)
            }
          }
          if (providers.has(id)) throw new Error(`${kind} provider already registered: ${id}`)
          providers.set(id, provider)
          onChange()
          let disposed = false
          const dispose = () => {
            if (disposed) return
            disposed = true
            if (providers.get(id) !== provider) return
            providers.delete(id)
            onChange()
          }
          owner.effect(() => dispose, `wework-${kind}-provider: ${id}`)
          return dispose
        },
        get(id) {
          return providers.get(requiredContributionId(id, `${kind} provider id`)) ?? null
        },
        list() {
          return [...providers.values()].sort(
            (left, right) => (left.order ?? 100) - (right.order ?? 100)
          )
        },
        async invoke(id, method, ...args) {
          const providerId = requiredContributionId(id, `${kind} provider id`)
          const provider = providers.get(providerId)
          if (!provider) throw new Error(`${kind} provider is not registered: ${providerId}`)
          const handler = provider[method]
          if (typeof handler !== 'function') {
            throw new Error(`${kind} provider "${providerId}" does not implement ${method}()`)
          }
          return handler(...args)
        },
        clear() {
          if (providers.size === 0) return
          providers.clear()
          onChange()
        },
      })
    }

    function createMemoryStorage() {
      const values = new Map()
      return {
        getItem(key) {
          return values.get(key) ?? null
        },
        setItem(key, value) {
          values.set(key, value)
        },
        removeItem(key) {
          values.delete(key)
        },
      }
    }

    function createScopedStorage(storage, namespace, notify) {
      const prefix = `wework.plugin.${requiredContributionId(namespace, 'Storage namespace')}.`
      const storageKey = key => `${prefix}${requiredContributionId(key, 'Storage key')}`
      return Object.freeze({
        get(key, fallback = null) {
          const raw = storage.getItem(storageKey(key))
          if (raw === null) return fallback
          try {
            return JSON.parse(raw)
          } catch {
            return fallback
          }
        },
        set(key, value) {
          const serialized = JSON.stringify(value)
          if (serialized === undefined) throw new Error('Storage value must be JSON-serializable')
          storage.setItem(storageKey(key), serialized)
          notify()
        },
        delete(key) {
          storage.removeItem(storageKey(key))
          notify()
        },
      })
    }

    function createLocalizationService(localeSource) {
      const getLocale = () => {
        const value = typeof localeSource === 'function' ? localeSource() : localeSource
        return typeof value === 'string' && value.trim() ? value.trim() : 'en'
      }
      return Object.freeze({
        getLocale,
        translate(messages, fallback = '') {
          if (typeof messages === 'string') return messages
          if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
            throw new Error('Localized messages must be a string or locale map')
          }
          const locale = getLocale()
          const language = locale.split('-')[0]
          const entries = Object.entries(messages)
          for (const candidate of [locale, language]) {
            const match = entries.find(([key]) => key.toLowerCase() === candidate.toLowerCase())
            if (typeof match?.[1] === 'string') return match[1]
          }
          const languageMatch = entries.find(([key]) => {
            const normalized = key.toLowerCase()
            return normalized.startsWith(`${language.toLowerCase()}-`)
          })
          if (typeof languageMatch?.[1] === 'string') return languageMatch[1]
          for (const candidate of ['en', 'zh-CN']) {
            const match = entries.find(([key]) => key.toLowerCase() === candidate.toLowerCase())
            if (typeof match?.[1] === 'string') return match[1]
          }
          return fallback
        },
      })
    }

    function matchesContextExpression(values, expression) {
      if (expression === undefined || expression === null) return true
      if (typeof expression === 'string') return Boolean(values.get(expression))
      if (Array.isArray(expression)) {
        return expression.every(item => matchesContextExpression(values, item))
      }
      if (typeof expression !== 'object') {
        throw new Error('Context expression must be a key, array, or expression object')
      }
      if (Array.isArray(expression.all)) {
        return expression.all.every(item => matchesContextExpression(values, item))
      }
      if (Array.isArray(expression.any)) {
        return expression.any.some(item => matchesContextExpression(values, item))
      }
      if ('not' in expression) return !matchesContextExpression(values, expression.not)
      const key = requiredContextKey(expression.key)
      if ('equals' in expression) return Object.is(values.get(key), expression.equals)
      if ('notEquals' in expression) return !Object.is(values.get(key), expression.notEquals)
      if ('in' in expression) {
        if (!Array.isArray(expression.in))
          throw new Error('Context expression "in" must be an array')
        return expression.in.some(value => Object.is(values.get(key), value))
      }
      return Boolean(values.get(key))
    }

    function createExtensionRuntime(options = {}) {
      let active = true
      let revision = 0
      const listeners = new Set()
      const contextValues = new Map()
      const contextContributions = new Map()
      const commandHandlers = new Map()
      const menuLocations = new Map()
      const storage = options.storage ?? createMemoryStorage()
      const secureStorage = options.secureStorage ?? null
      const backendFetch = options.fetch ?? window.fetch?.bind(window)
      const localization = createLocalizationService(
        options.locale ??
          (() => window.document?.documentElement?.lang || window.navigator?.language || 'en')
      )
      let activeComposer = null

      const assertActive = () => {
        if (!active) throw new Error('Wework extension runtime is disposed')
      }
      const notify = () => {
        revision += 1
        for (const listener of [...listeners]) listener()
      }
      const commands = createContributionRegistry('command', notify)
      const composerReferences = createContributionRegistry('composer-reference', notify)
      const configurations = createContributionRegistry('configuration', notify)
      const keybindings = createContributionRegistry('keybinding', notify)
      const contributions = createContributionCatalog(notify)
      const chatProviders = createProviderRegistry('chat', ['prepareContext'], notify)
      const testingProviders = createProviderRegistry('testing', ['discover', 'run'], notify)
      const environmentProviders = createProviderRegistry(
        'environment',
        ['inspect', 'prepare'],
        notify
      )

      const service = Object.freeze({
        backend: Object.freeze({
          scope(rawNamespace) {
            assertActive()
            const plugin = requiredContributionId(rawNamespace, 'Plugin backend namespace')
            return Object.freeze({
              async request(rawMethod, params = {}) {
                assertActive()
                const method = requiredContributionId(rawMethod, 'Plugin backend method')
                if (!params || typeof params !== 'object' || Array.isArray(params)) {
                  throw new Error('Plugin backend params must be an object')
                }
                if (typeof backendFetch !== 'function') {
                  throw new Error('Plugin backend transport is unavailable')
                }
                const response = await backendFetch(PLUGIN_BACKEND_PATH, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ plugin, method, params }),
                })
                const payload = await response.json()
                if (!response.ok || !payload?.ok) {
                  const error = new Error(
                    payload?.error?.message || `Plugin backend request failed: ${response.status}`
                  )
                  error.code = payload?.error?.code ?? 'backend_failed'
                  error.retryable = Boolean(payload?.error?.retryable)
                  throw error
                }
                return payload.result
              },
            })
          },
        }),
        commands: Object.freeze({
          register(owner, definition, handler) {
            assertActive()
            if (typeof handler !== 'function') throw new Error('Command handler must be a function')
            const id = requiredContributionId(definition?.id, 'Command id')
            if (commandHandlers.has(id))
              throw new Error(`Command handler already registered: ${id}`)
            const disposeDefinition = commands.register(owner, definition)
            commandHandlers.set(id, handler)
            let disposed = false
            const dispose = () => {
              if (disposed) return
              disposed = true
              if (commandHandlers.get(id) === handler) commandHandlers.delete(id)
              disposeDefinition()
            }
            owner.effect(() => dispose, `wework-command-handler: ${id}`)
            return dispose
          },
          get(id) {
            return commands.get(id)
          },
          list() {
            return commands.list()
          },
          async execute(id, args, invocation = {}) {
            assertActive()
            const commandId = requiredContributionId(id, 'Command id')
            const definition = commands.get(commandId)
            const handler = commandHandlers.get(commandId)
            if (!definition || !handler) throw new Error(`Command is not registered: ${commandId}`)
            if (!matchesContextExpression(contextValues, definition.enablement)) {
              throw new Error(`Command is disabled: ${commandId}`)
            }
            return handler(args, Object.freeze({ source: 'api', ...invocation, commandId }))
          },
          subscribe(listener) {
            assertActive()
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        }),
        context: Object.freeze({
          set(owner, rawKey, value) {
            assertActive()
            requiredOwner(owner, 'Context registration')
            const key = requiredContextKey(rawKey)
            const token = Object.freeze({})
            let contributions = contextContributions.get(key)
            if (!contributions) {
              contributions = new Map()
              contextContributions.set(key, contributions)
            }
            contributions.set(token, value)
            contextValues.set(key, value)
            notify()
            let disposed = false
            const dispose = () => {
              if (disposed) return
              disposed = true
              contributions.delete(token)
              const remaining = [...contributions.values()]
              if (remaining.length > 0) contextValues.set(key, remaining.at(-1))
              else {
                contextContributions.delete(key)
                contextValues.delete(key)
              }
              notify()
            }
            owner.effect(() => dispose, `wework-context: ${key}`)
            return dispose
          },
          get(key) {
            return contextValues.get(requiredContextKey(key))
          },
          entries() {
            return Object.freeze(Object.fromEntries(contextValues))
          },
          matches(expression) {
            return matchesContextExpression(contextValues, expression)
          },
          subscribe(listener) {
            assertActive()
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        }),
        composer: Object.freeze({
          bind(controller) {
            assertActive()
            if (!controller || typeof controller !== 'object') {
              throw new Error('Composer controller must be an object')
            }
            activeComposer = controller
            return () => {
              if (activeComposer === controller) activeComposer = null
            }
          },
          focus() {
            activeComposer?.focus()
          },
          getValue() {
            return activeComposer?.getValue() ?? ''
          },
          insertText(text) {
            if (!activeComposer) throw new Error('No active Wework composer')
            activeComposer.insertText(text)
          },
          setValue(value, selectionOffset) {
            if (!activeComposer) throw new Error('No active Wework composer')
            activeComposer.setValue(value, selectionOffset)
          },
          references: Object.freeze({
            register(owner, definition) {
              assertActive()
              if (!definition || typeof definition !== 'object') {
                throw new Error('Composer reference definition must be an object')
              }
              if (typeof definition.title !== 'string' || !definition.title.trim()) {
                throw new Error('Composer reference title is required')
              }
              if (typeof definition.reference !== 'string' || !definition.reference.trim()) {
                throw new Error('Composer reference value is required')
              }
              return composerReferences.register(owner, definition)
            },
            list() {
              return composerReferences
                .list()
                .filter(reference => matchesContextExpression(contextValues, reference.when))
                .map(reference =>
                  Object.freeze({
                    ...reference,
                    enabled: matchesContextExpression(contextValues, reference.enablement),
                  })
                )
                .sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
            },
            subscribe(listener) {
              assertActive()
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
          }),
        }),
        contributions,
        chat: Object.freeze({
          providers: chatProviders,
          prepareContext(id, request) {
            return chatProviders.invoke(id, 'prepareContext', request)
          },
        }),
        testing: Object.freeze({
          providers: testingProviders,
          discover(id, request) {
            return testingProviders.invoke(id, 'discover', request)
          },
          run(id, request) {
            return testingProviders.invoke(id, 'run', request)
          },
          cancel(id, runId) {
            return testingProviders.invoke(id, 'cancel', runId)
          },
        }),
        environments: Object.freeze({
          providers: environmentProviders,
          inspect(id, request) {
            return environmentProviders.invoke(id, 'inspect', request)
          },
          prepare(id, request) {
            return environmentProviders.invoke(id, 'prepare', request)
          },
          switchTo(id, request) {
            return environmentProviders.invoke(id, 'switchTo', request)
          },
        }),
        menus: Object.freeze({
          register(owner, rawLocation, rawItem) {
            assertActive()
            requiredOwner(owner, 'Menu registration')
            const location = requiredContributionId(rawLocation, 'Menu location')
            const item = freezeContribution(rawItem)
            const id = requiredContributionId(item.id, 'Menu item id')
            let entries = menuLocations.get(location)
            if (!entries) {
              entries = new Map()
              menuLocations.set(location, entries)
            }
            if (entries.has(id)) throw new Error(`Menu item already registered: ${location}/${id}`)
            entries.set(id, item)
            notify()
            let disposed = false
            const dispose = () => {
              if (disposed) return
              disposed = true
              if (entries.get(id) !== item) return
              entries.delete(id)
              if (entries.size === 0) menuLocations.delete(location)
              notify()
            }
            owner.effect(() => dispose, `wework-menu: ${location}/${id}`)
            return dispose
          },
          list(location) {
            const entries = [
              ...(menuLocations.get(requiredContributionId(location, 'Menu location'))?.values() ??
                []),
            ]
            return entries
              .filter(item => matchesContextExpression(contextValues, item.when))
              .map(item =>
                Object.freeze({
                  ...item,
                  enabled: matchesContextExpression(contextValues, item.enablement),
                })
              )
              .sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
          },
          subscribe(listener) {
            assertActive()
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        }),
        keybindings: Object.freeze({
          register(owner, definition) {
            assertActive()
            const id = requiredContributionId(definition?.id, 'Keybinding id')
            requiredContributionId(definition?.command, 'Keybinding command')
            return keybindings.register(owner, { ...definition, id })
          },
          list() {
            return keybindings
              .list()
              .filter(binding => matchesContextExpression(contextValues, binding.when))
          },
          subscribe(listener) {
            assertActive()
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        }),
        localization,
        configuration: Object.freeze({
          register(owner, definition) {
            assertActive()
            if (!definition || typeof definition !== 'object') {
              throw new Error('Configuration definition must be an object')
            }
            return configurations.register(owner, definition)
          },
          getDefinition(id) {
            return configurations.get(id)
          },
          get(id) {
            const definition = configurations.get(requiredContributionId(id, 'Configuration id'))
            if (!definition) return null
            const persisted = createScopedStorage(storage, 'configuration', notify).get(
              definition.id,
              {}
            )
            return Object.freeze({ ...(definition.defaults ?? {}), ...persisted })
          },
          update(id, patch) {
            assertActive()
            const configurationId = requiredContributionId(id, 'Configuration id')
            const definition = configurations.get(configurationId)
            if (!definition) throw new Error(`Configuration is not registered: ${configurationId}`)
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
              throw new Error('Configuration patch must be an object')
            }
            const current = service.configuration.get(configurationId)
            const next = Object.freeze({ ...current, ...patch })
            if (typeof definition.validate === 'function') definition.validate(next)
            createScopedStorage(storage, 'configuration', notify).set(configurationId, next)
            return next
          },
          subscribe(listener) {
            assertActive()
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        }),
        storage: Object.freeze({
          scope(namespace) {
            assertActive()
            return createScopedStorage(storage, namespace, notify)
          },
        }),
        secrets: Object.freeze({
          scope(namespace) {
            assertActive()
            if (!secureStorage) throw new Error('Secure storage is unavailable')
            const prefix = `${requiredContributionId(namespace, 'Secret namespace')}.`
            const secretKey = key => `${prefix}${requiredContributionId(key, 'Secret key')}`
            return Object.freeze({
              get: key => secureStorage.get(secretKey(key)),
              set: (key, value) => secureStorage.set(secretKey(key), value),
              delete: key => secureStorage.delete(secretKey(key)),
            })
          },
        }),
      })

      return {
        service,
        host: Object.freeze({
          getRevision: () => revision,
          subscribe(listener) {
            assertActive()
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          commands: service.commands,
          backend: service.backend,
          chat: service.chat,
          composer: service.composer,
          contributions: service.contributions,
          context: service.context,
          environments: service.environments,
          menus: service.menus,
          keybindings: service.keybindings,
          localization: service.localization,
          configuration: service.configuration,
          storage: service.storage,
          secrets: service.secrets,
          testing: service.testing,
        }),
        dispose() {
          if (!active) return
          active = false
          listeners.clear()
          commandHandlers.clear()
          activeComposer = null
          commands.clear()
          composerReferences.clear()
          contributions.clear()
          configurations.clear()
          chatProviders.clear()
          environmentProviders.clear()
          contextContributions.clear()
          keybindings.clear()
          contextValues.clear()
          menuLocations.clear()
          testingProviders.clear()
        },
      }
    }

    function resolveLabel(label, fallback) {
      try {
        return typeof label === 'function' ? label() : label || fallback
      } catch (error) {
        console.error(`[Wework] Failed to resolve DSH slot label "${fallback}":`, error)
        return fallback
      }
    }

    function createSlotRuntime(context, contributions) {
      const listeners = new Set()
      const mounts = new Map()
      const snapshots = new Map()
      let invalidateRoot = () => {}
      let nextMountId = 0

      const refresh = slotName => {
        const entries = new Map(contributions.list(slotName).map(entry => [entry.id, { ...entry }]))
        for (const entry of context.slots.entriesOfSlot(slotName)) {
          const id = entry.options.id ?? entry.options.key
          if (!id) continue
          entries.set(id, {
            ...(entries.get(id) ?? {}),
            ...entry.options,
            id,
            label: resolveLabel(entry.options.label, entries.get(id)?.label ?? id),
            order: entry.options.order ?? entries.get(id)?.order ?? 100,
          })
        }
        snapshots.set(
          slotName,
          [...entries.values()].sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
        )
        for (const subscription of [...listeners]) {
          if (subscription.slotName === slotName) subscription.listener()
        }
        invalidateRoot()
      }

      return {
        mounts,
        setInvalidateRoot(listener) {
          invalidateRoot = listener
        },
        refresh,
        getEntries(slotName) {
          return snapshots.get(slotName) ?? []
        },
        subscribe(slotName, listener) {
          const subscription = { slotName, listener }
          listeners.add(subscription)
          return () => listeners.delete(subscription)
        },
        attach(slotName, id, container, props) {
          const token = `${slotName}:${id ?? '*'}:${++nextMountId}`
          const mounted = { token, slotName, id, container, props }
          mounts.set(token, mounted)
          invalidateRoot()
          return {
            update(nextProps) {
              mounted.props = nextProps
              invalidateRoot()
            },
            dispose() {
              mounts.delete(token)
              invalidateRoot()
            },
          }
        },
      }
    }

    function createWeworkSlotGroup(slotRuntime, slotNames) {
      return function WeworkSlotGroup({ renderSlot, renderSlotChain, revision }) {
        return createElement(
          Fragment,
          null,
          ...[...slotRuntime.mounts.values()]
            .filter(mount => slotNames.includes(mount.slotName))
            .map(mount =>
              createPortal(
                SLOT_DECLARATIONS[mount.slotName]?.kind === 'chain'
                  ? renderSlotChain(mount.slotName, mount.props)
                  : renderSlot(
                      mount.slotName,
                      mount.props,
                      mount.id === undefined ? undefined : { only: mount.id }
                    ),
                mount.container,
                mount.token
              )
            )
        )
      }
    }

    function createWeworkRoot(
      context,
      hostWindow = window,
      extensionRuntime = createExtensionRuntime(),
      providedSlotRuntime
    ) {
      const slotRuntime =
        providedSlotRuntime ?? createSlotRuntime(context, extensionRuntime.service.contributions)
      return function WeworkRoot({ renderSlot, renderSlotChain }) {
        const containerRef = useRef(null)
        const [error, setError] = useState(null)
        const [revision, setRevision] = useState(0)

        useEffect(() => {
          let disposed = false
          let unmount = () => {}
          slotRuntime.setInvalidateRoot(() => setRevision(value => value + 1))
          hostWindow.__WEWORK_DSH_UI__ = slotRuntime
          hostWindow.__WEWORK_DSH_EXTENSIONS__ = extensionRuntime.host
          const unsubscribeContributions = extensionRuntime.host.subscribe(() => {
            for (const slotName of Object.keys(SLOT_DECLARATIONS)) slotRuntime.refresh(slotName)
          })
          const unsubscribers = Object.keys(SLOT_DECLARATIONS).map(slotName => {
            slotRuntime.refresh(slotName)
            return context.slots.subscribe(slotName, () => slotRuntime.refresh(slotName))
          })

          const mount = () => {
            const container = containerRef.current
            const runtime = hostWindow.__WEWORK_APP_RUNTIME__
            if (!container || !runtime) return false
            hostWindow.removeEventListener(APP_RUNTIME_READY_EVENT, mount)
            Promise.resolve(runtime.mount(container, context)).then(
              dispose => {
                if (disposed) {
                  dispose()
                  return
                }
                unmount = dispose
              },
              reason => {
                if (!disposed) {
                  setError(reason instanceof Error ? reason.message : String(reason))
                }
              }
            )
            return true
          }

          if (!mount()) hostWindow.addEventListener(APP_RUNTIME_READY_EVENT, mount)
          return () => {
            disposed = true
            hostWindow.removeEventListener(APP_RUNTIME_READY_EVENT, mount)
            for (const unsubscribe of unsubscribers) unsubscribe()
            unsubscribeContributions()
            slotRuntime.setInvalidateRoot(() => {})
            if (hostWindow.__WEWORK_DSH_UI__ === slotRuntime) {
              delete hostWindow.__WEWORK_DSH_UI__
            }
            if (hostWindow.__WEWORK_DSH_EXTENSIONS__ === extensionRuntime.host) {
              delete hostWindow.__WEWORK_DSH_EXTENSIONS__
            }
            unmount()
          }
        }, [])

        if (error) {
          return createElement(
            'main',
            {
              'data-testid': 'wework-dsh-root-error',
              style: {
                alignItems: 'center',
                display: 'flex',
                height: '100vh',
                justifyContent: 'center',
                padding: '24px',
              },
            },
            `Wework failed to mount: ${error}`
          )
        }
        const slotEntries = Object.fromEntries(
          Object.keys(SLOT_DECLARATIONS).map(slotName => [
            slotName,
            slotRuntime.getEntries(slotName).map(entry => entry.id),
          ])
        )
        return createElement(
          Fragment,
          null,
          createElement('div', {
            ref: containerRef,
            'data-testid': 'wework-dsh-root',
            'data-wework-dsh-slots': JSON.stringify(slotEntries),
            style: { height: '100vh', width: '100vw' },
          }),
          ...Object.keys(SLOT_GROUP_DECLARATIONS).map(slotName =>
            renderSlot(slotName, { revision })
          )
        )
      }
    }

    const inject = ['slots', 'weworkDesktop']

    function apply(ctx) {
      const extensionRuntime = createExtensionRuntime({
        secureStorage: ctx.weworkDesktop?.secureStorage,
        storage: window.localStorage ?? createMemoryStorage(),
      })
      const slotRuntime = createSlotRuntime(ctx, extensionRuntime.service.contributions)
      ctx.provide(
        'wework',
        Object.freeze({
          host: ctx.weworkDesktop,
          ...extensionRuntime.service,
        })
      )
      ctx.effect(() => () => extensionRuntime.dispose(), 'wework-app: extension runtime generation')
      ctx.slots.register(
        {
          name: 'root',
          priority: ROOT_PRIORITY,
          children: SLOT_GROUP_DECLARATIONS,
        },
        createWeworkRoot(ctx, window, extensionRuntime, slotRuntime)
      )
      for (const [slotName, children] of Object.entries(SLOT_GROUPS)) {
        ctx.slots.register(
          {
            name: slotName,
            priority: ROOT_PRIORITY,
            children,
          },
          createWeworkSlotGroup(slotRuntime, Object.keys(children))
        )
      }
    }

    exports.APP_RUNTIME_READY_EVENT = APP_RUNTIME_READY_EVENT
    exports.SLOT_DECLARATIONS = SLOT_DECLARATIONS
    exports.SLOT_GROUP_DECLARATIONS = SLOT_GROUP_DECLARATIONS
    exports.SLOT_GROUPS = SLOT_GROUPS
    exports.apply = apply
    exports.createExtensionRuntime = createExtensionRuntime
    exports.createWeworkRoot = createWeworkRoot
    exports.inject = inject
    return module.exports
  },
})
