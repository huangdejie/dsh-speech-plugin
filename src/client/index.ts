/**
 * Speech plugin, browser half: the per-message speak button in the
 * assistant-message action strip and the auto-announce toggle in the session
 * header, over the Web Speech API and the `ui-speech` settings namespace.
 * @module dsh-speech-plugin/client
 */
import type { ClientContext, SessionId, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merges (both target slots).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the settingsScope Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  ANNOUNCE_FIELD, DEFAULT_ANNOUNCE_MODE, SPEECH_SETTINGS_NAMESPACE,
  type AnnounceMode, type SpeechSettings,
} from '../speech-settings.ts'
import { SpeechController } from './controller.ts'
import { watchSessionSpeech } from './speech-watcher.ts'
import { SpeechActions } from './SpeechActions.tsx'
import { AnnounceToggle } from './AnnounceToggle.tsx'
import { SPEECH_CSS } from './styles.ts'
import { en, zh, type SpeechKey } from './locales.ts'
import type { AnnounceToggleInjected, SpeechInjected } from './slots.ts'

export type {
  AnnounceToggleInjected, AnnounceToggleProps, SpeechInjected, SpeechActionProps,
} from './slots.ts'
export type { SpeechKey } from './locales.ts'
export type { SpeechView } from './controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The speech controls' copy. */
    speech: SpeechKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'speech'

/** Required services: the slot registry, session bindings, copy, and the settings transport. */
export const inject = ['slots', 'sessions', 'locale', 'connection', 'remote', 'settingsScope']

/** Per-Session speech resources: one controller plus one auto-announce watcher. */
interface SessionSpeech {
  readonly controller: SpeechController
  readonly stopWatch: () => void
}

/**
 * Client plugin body: both slot entries and their per-session object layer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Non-browser boots (node e2e, SSR-ish environments) implement neither
  // window nor Audio; degrade silently so those environments stay green. The
  // cloud path needs only Audio — system voices are additionally detected in
  // the controller when it falls back.
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-speech: dictionaries')

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-speech-plugin'
    tag.textContent = SPEECH_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-speech: stylesheet')

  const scope: SettingsScope<SpeechSettings> = ctx.settingsScope.bind<SpeechSettings>({
    namespace: SPEECH_SETTINGS_NAMESPACE,
  })
  const announceEnabled = (): boolean => scope.getSnapshot().value?.announce === 'on'
  const announceView = {
    getSnapshot: (): AnnounceMode => scope.getSnapshot().value?.announce ?? DEFAULT_ANNOUNCE_MODE,
    subscribe: (listener: () => void): (() => void) => scope.subscribe(listener),
  }

  const sessions = new Map<SessionId, SessionSpeech>()
  const resourcesFor = (sessionId: SessionId): SessionSpeech => {
    let resources = sessions.get(sessionId)
    if (resources === undefined) {
      const controller = new SpeechController()
      const session = ctx.sessions.binding(sessionId)?.session
      const stopWatch = session === undefined
        ? () => {}
        : watchSessionSpeech(
          session,
          announceEnabled,
          (messageId, text) => controller.toggle(messageId, text),
        )
      resources = { controller, stopWatch }
      sessions.set(sessionId, resources)
    }
    return resources
  }

  // Registered before the slot contributions so fiber unwind disposes the
  // controllers after both entries are withdrawn.
  ctx.effect(() => () => {
    for (const { controller, stopWatch } of sessions.values()) {
      stopWatch()
      controller.dispose()
    }
    sessions.clear()
  }, 'dsh-speech: session resources')

  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    const dispose = ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'speech',
      order: 20,
      locale: NS,
      inject: (sessionId): SpeechInjected => {
        const { controller } = resourcesFor(sessionId)
        return {
          hooks: { speech: controller },
          toggle: (messageId, text) => controller.toggle(messageId, text),
        }
      },
    }, SpeechActions)
    return dispose
  })

  ctx.slots.inject('conversation.session.header.utilities', () => {
    const dispose = ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'speech',
      order: 20,
      locale: NS,
      inject: (): AnnounceToggleInjected => ({
        hooks: { announce: announceView },
        setAnnounce: mode => { void scope.set(ANNOUNCE_FIELD, mode) },
      }),
    }, AnnounceToggle)
    return dispose
  })
}
