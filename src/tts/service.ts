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
import { TtsError, type TtsProvider, type TtsResponse } from './types.ts'

/** Attempts per chunk: the original call plus two retries for transient failures. */
const MAX_ATTEMPTS = 3

/** Backoff between retries, linear in the attempt number. */
const RETRY_DELAY_MS = 400

/** First-chunk character budget: synthesis latency grows with length, so a
 * short opener starts playback in ~1-2s while the rest synthesizes behind it. */
const FIRST_CHUNK_CHARS = 80

/** Promise-based delay without a trailing-timer leak risk. */
const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** No cloud engine is usable; the browser falls back to system voices. */
export class UnavailableError extends Error {}

/** Resolve the DashScope console API Key from the environment. */
export function dashscopeApiKey(): string | undefined {
  const value = process.env.SPEECH_DASHSCOPE_API_KEY
  return value !== undefined && value !== '' ? value : undefined
}

/** Resolve the Volcengine console API Key from the environment. */
export function volcengineApiKey(): string | undefined {
  const value = process.env.SPEECH_VOLCENGINE_API_KEY
  return value !== undefined && value !== '' ? value : undefined
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
        const apiKey = dashscopeApiKey()
        if (apiKey !== undefined) {
          return {
            provider: dashscopeProvider(
              { model: this.config.dashscopeModel, voice: this.config.dashscopeVoice },
              apiKey,
            ),
          }
        }
        if (this.config.engine === 'dashscope') {
          return { reason: 'engine is dashscope but SPEECH_DASHSCOPE_API_KEY is not set' }
        }
      } else {
        const apiKey = volcengineApiKey()
        if (apiKey !== undefined) {
          return {
            provider: volcengineProvider(
              { model: this.config.volcengineResourceId, voice: this.config.volcengineVoice },
              apiKey,
            ),
          }
        }
        if (this.config.engine === 'volcengine') {
          return {
            reason: 'engine is volcengine but SPEECH_VOLCENGINE_API_KEY is not set',
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
   * The active provider's engine and media type, for the stream's header.
   */
  describe(): { engine: string; contentType: string } | undefined {
    const resolved = this.provider()
    return 'provider' in resolved
      ? { engine: resolved.provider.engine, contentType: resolved.provider.contentType }
      : undefined
  }

  /**
   * Synthesize one message, yielding each Base64 part the moment it is ready
   * so playback starts with the first chunk instead of waiting for the whole
   * message. A cache hit yields every part immediately. The cache is written
   * only after the final part, so a partial failure never poisons it.
   * @param text - cleaned plain text; at most `maxTextLength` characters.
   * @yields Base64 audio parts in playback order.
   */
  async *synthesizeParts(text: string): AsyncGenerator<string, void, undefined> {
    const resolved = this.provider()
    if (!('provider' in resolved)) throw new UnavailableError(resolved.reason)
    const provider = resolved.provider
    const cacheKey = createHash('sha1')
      .update(`${provider.engine}\0${provider.settingsKey}\0${text}`)
      .digest('hex')
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) {
      for (const part of cached.parts) yield part
      return
    }

    const chunks = splitForSpeech(text, provider.maxChars, FIRST_CHUNK_CHARS)
    const parts: string[] = []
    for (const chunk of chunks) {
      // Transient failures (throttle, busy backend, timeout) are retried in
      // place; deterministic ones surface immediately and stop the stream.
      let base64: string | undefined
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          base64 = (await provider.synthesize(chunk)).base64
          break
        } catch (error) {
          const retryable = error instanceof TtsError && error.retryable
          if (!retryable || attempt === MAX_ATTEMPTS) throw error
          await delay(RETRY_DELAY_MS * attempt)
        }
      }
      parts.push(base64!)
      yield base64!
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
  }
}
