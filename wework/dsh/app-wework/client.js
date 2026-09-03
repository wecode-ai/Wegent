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
    const ROOT_PRIORITY = -100
    const SLOT_DECLARATIONS = {
      'wework.action': { kind: 'list', scope: 'root' },
      'wework.app': { kind: 'list', scope: 'root' },
      'wework.board.card.status': { kind: 'list', scope: 'root' },
      'wework.environment.section': { kind: 'list', scope: 'root' },
      'wework.project.create.section': { kind: 'list', scope: 'root' },
      'wework.project.work.section': { kind: 'list', scope: 'root' },
      'wework.route': { kind: 'list', scope: 'root' },
      'wework.runtime-profile.workspace-policy': { kind: 'list', scope: 'root' },
      'wework.settings.page': { kind: 'list', scope: 'root' },
      'wework.sidebar.navigation': { kind: 'list', scope: 'root' },
      'wework.shell.after': { kind: 'list', scope: 'root' },
      'wework.shell.before': { kind: 'list', scope: 'root' },
      'wework.shell.overlay': { kind: 'list', scope: 'root' },
      'wework.task.status': { kind: 'list', scope: 'root' },
      'wework.workspace.menu.section': { kind: 'list', scope: 'root' },
      'wework.workspace.sidebar.tab': { kind: 'list', scope: 'root' },
      'wework.workspace.tab': { kind: 'list', scope: 'root' },
    }

    function resolveLabel(label, fallback) {
      try {
        return typeof label === 'function' ? label() : label || fallback
      } catch (error) {
        console.error(`[Wework] Failed to resolve DSH slot label "${fallback}":`, error)
        return fallback
      }
    }

    function contributionDescriptor(entry) {
      const descriptor = entry.component?.wework
      return descriptor && typeof descriptor === 'object' ? descriptor : {}
    }

    function registerWeworkContribution(ctx, slotName, descriptor, component = () => null) {
      Object.defineProperty(component, 'wework', {
        configurable: true,
        value: Object.freeze({ ...descriptor }),
      })
      const { id, label, order, priority } = descriptor
      return ctx.slots.register(
        {
          name: slotName,
          id,
          ...(label !== undefined ? { label } : {}),
          ...(order !== undefined ? { order } : {}),
          ...(priority !== undefined ? { priority } : {}),
        },
        component
      )
    }

    function createSlotRuntime(context) {
      const listeners = new Set()
      const mounts = new Map()
      const snapshots = new Map()
      let invalidateRoot = () => {}
      let nextMountId = 0

      const refresh = slotName => {
        snapshots.set(
          slotName,
          context.slots.entriesOfSlot(slotName).map(entry => ({
            ...contributionDescriptor(entry),
            ...entry.options,
            id: entry.options.id,
            label: resolveLabel(entry.options.label, entry.options.id),
            order: entry.options.order ?? 100,
          }))
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

    function createWeworkRoot(context, hostWindow = window) {
      const slotRuntime = createSlotRuntime(context)
      return function WeworkRoot({ renderSlot }) {
        const containerRef = useRef(null)
        const [error, setError] = useState(null)
        const [, setRevision] = useState(0)

        useEffect(() => {
          let disposed = false
          let unmount = () => {}
          slotRuntime.setInvalidateRoot(() => setRevision(value => value + 1))
          hostWindow.__WEWORK_DSH_UI__ = slotRuntime
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
            slotRuntime.setInvalidateRoot(() => {})
            if (hostWindow.__WEWORK_DSH_UI__ === slotRuntime) {
              delete hostWindow.__WEWORK_DSH_UI__
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
          ...[...slotRuntime.mounts.values()].map(mount =>
            createPortal(
              renderSlot(
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

    const inject = ['slots']

    function apply(ctx) {
      ctx.provide('wework', {
        ui: {
          register(contributionCtx, slotName, descriptor, component) {
            return registerWeworkContribution(contributionCtx, slotName, descriptor, component)
          },
        },
      })
      ctx.slots.register(
        {
          name: 'root',
          priority: ROOT_PRIORITY,
          children: SLOT_DECLARATIONS,
        },
        createWeworkRoot(ctx)
      )
    }

    exports.APP_RUNTIME_READY_EVENT = APP_RUNTIME_READY_EVENT
    exports.SLOT_DECLARATIONS = SLOT_DECLARATIONS
    exports.apply = apply
    exports.createWeworkRoot = createWeworkRoot
    exports.inject = inject
    return module.exports
  },
})
