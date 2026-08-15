/**
 * Speech plugin, node half: registers the durable `ui-speech` settings
 * section. The browser half ships as exports["./client"], discovered through
 * this package's `dsh.client` declaration.
 */
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SPEECH_SETTINGS_NAMESPACE, SpeechSettingsSchema } from './speech-settings.ts'

export {
  ANNOUNCE_FIELD, ANNOUNCE_MODES, DEFAULT_ANNOUNCE_MODE, SPEECH_SETTINGS_NAMESPACE,
  SpeechSettingsSchema, type AnnounceMode, type SpeechSettings,
} from './speech-settings.ts'

const SPEECH_NAMESPACE = settingsNamespace(SPEECH_SETTINGS_NAMESPACE)

/**
 * Register the durable speech section when the settings service is composed.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SPEECH_NAMESPACE, SpeechSettingsSchema)
  })
}
