/**
 * Host-side synthesis service: resolves the engine from config plus present
 * credentials, splits long text into provider-sized chunks, synthesizes them
 * in order, and caches whole-message responses so repeated clicks on the same
 * message cost nothing.
 */
import { createHash } from 'node:crypto'
import type { CloudEngine, SpeechPluginConfig } from '../config.ts'
import { dashscopeProvider } from './dashscope.ts'
import { volcengineProvider } from './volcengine.ts'
import { splitForSpeech } from './split-text.ts'
import type { TtsProvider, TtsResponse } from './types.ts'

/** Route answer when no cloud engine is usable. */
export interface EngineUnavailable {
  readonly ok: false
  readonly code: 'tts-unavailable'
  readonly message: string
}

/** Whole-message synthesis result, or the unavailable marker. */
export type SynthesisResult = TtsResponse | EngineUnavailable

/** Volcengine credentials resolved from environment plus config. */
interface VolcengineCredentials {
  readonly appId: string
  readonly accessToken: string
}

function volcengineCredentials(config: SpeechPluginConfig): VolcengineCredentials | undefined {
  const accessToken = process.env.VOLCENGINE_TTS_ACCESS_TOKEN
  const appId = config.volcengineAppId !== ''
    ? config.volcengineAppId
    : process.env.VOLCENGINE_TTS_APP_ID
  if (accessToken === undefined || accessToken === '' || appId === undefined || appId === '') {
    return undefined
  }
  return { appId, accessToken }
}

/**
 * The synthesis service: engine resolution, chunking, orchestration, cache.
 */
export class SpeechTTSService {
  private readonly cache = new Map<string, TtsResponse>()

  /**
   * @param config - resolved plugin configuration.
   */
  constructor(private readonly config: SpeechPluginConfig) {}

  /**
   * The active provider under the configured engine selector, or why none is.
   * 'auto' prefers DashScope, then Volcengine, by present credentials.
   */
  private provider(): { provider: TtsProvider } | { reason: string } {
    const want: CloudEngine[] = this.config.engine === 'auto'
      ? ['dashscope', 'volcengine']
      : this.config.engine === 'system'
        ? []
        : [this.config.engine]
    for (const engine of want) {
      if (engine === 'dashscope') {
        const apiKey = process.env.DASHSCOPE_API_KEY
        if (apiKey !== undefined && apiKey !== '') {
          return {
            provider: dashscopeProvider(
              { model: this.config.dashscopeModel, voice: this.config.dashscopeVoice },
              apiKey,
            ),
          }
        }
        if (this.config.engine === 'dashscope') {
          return { reason: 'engine is dashscope but DASHSCOPE_API_KEY is not set' }
        }
      } else {
        const credentials = volcengineCredentials(this.config)
        if (credentials !== undefined) {
          return {
            provider: volcengineProvider(
              { model: this.config.volcengineModel, voice: this.config.volcengineVoice },
              credentials.appId,
              credentials.accessToken,
            ),
          }
        }
        if (this.config.engine === 'volcengine') {
          return {
            reason: 'engine is volcengine but VOLCENGINE_TTS_ACCESS_TOKEN'
              + ' and an app id are not set',
          }
        }
      }
    }
    return { reason: 'engine is system or no cloud credentials are present' }
  }

  /**
   * Whether a cloud engine answers requests (drives the route's 503).
   */
  available(): boolean {
    return 'provider' in this.provider()
  }

  /**
   * Synthesize one whole message.
   * @param text - cleaned plain text; at most `maxTextLength` characters.
   * @returns the cached or fresh response, or the unavailable marker.
   */
  async synthesize(text: string): Promise<SynthesisResult> {
    const resolved = this.provider()
    if (!('provider' in resolved)) {
      return { ok: false, code: 'tts-unavailable', message: resolved.reason }
    }
    const provider = resolved.provider
    const cacheKey = createHash('sha1')
      .update(`${provider.engine}\0${provider.settingsKey}\0${text}`)
      .digest('hex')
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) return cached

    const chunks = splitForSpeech(text, provider.maxChars)
    const parts: string[] = []
    for (const chunk of chunks) {
      const segment = await provider.synthesize(chunk)
      parts.push(segment.base64)
    }
    const response: TtsResponse = {
      ok: true,
      engine: provider.engine,
      contentType: provider.contentType,
      parts,
    }
    this.cache.set(cacheKey, response)
    while (this.cache.size > this.config.cacheEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    return response
  }
}
