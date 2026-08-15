/** Auto-announce preference stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
export const SPEECH_SETTINGS_NAMESPACE = 'ui-speech'

/** Field carrying whether newly settled assistant messages are spoken aloud. */
export const ANNOUNCE_FIELD = 'announce'

/** Announce modes accepted at settings boundaries. */
export const ANNOUNCE_MODES = ['off', 'on'] as const

/** Configurable auto-announce behavior. */
export type AnnounceMode = typeof ANNOUNCE_MODES[number]

/** Default keeps speech opt-in: browsers gate unattended audio on user activation. */
export const DEFAULT_ANNOUNCE_MODE: AnnounceMode = 'off'

/** Durable speech section shared by the Host schema and the browser scope. */
export interface SpeechSettings {
  /** Whether newly settled assistant messages are spoken automatically. */
  announce: AnnounceMode
}

/** Durable speech schema; also the wire envelope the browser scope validates against. */
export const SpeechSettingsSchema: z<SpeechSettings> = z.object({
  [ANNOUNCE_FIELD]: z.union([...ANNOUNCE_MODES]).default(DEFAULT_ANNOUNCE_MODE),
})
