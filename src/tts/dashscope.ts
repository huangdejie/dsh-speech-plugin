/**
 * Aliyun Bailian (DashScope) TTS provider over the non-realtime multimodal
 * generation endpoint: one POST per chunk, Bearer key, Base64 audio (or a
 * 24-hour result URL) in the JSON response.
 */
import { TtsError, type TtsProvider, type TtsProviderConfig, type TtsSegment } from './types.ts'

const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

/** Non-realtime API input limit for non-Qwen-TTS models, kept below it for margin. */
const MAX_CHARS = 550

/** One chunk synthesis budget; timeouts are transient by nature. */
const REQUEST_TIMEOUT_MS = 30_000

/** Run one fetch, classifying network and timeout throws as retryable. */
async function fetchOrRetryable(
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw new TtsError(
      `dashscope tts request failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    )
  }
}

/** Response payload shape of the non-realtime endpoint (only the fields read). */
interface DashScopePayload {
  readonly output?: {
    readonly audio?: {
      readonly data?: string
      readonly url?: string
    }
  }
  readonly code?: string
  readonly message?: string
}

/** Build the DashScope provider.
 * @param config - model and voice settings.
 * @param apiKey - SPEECH_DASHSCOPE_API_KEY credential.
 */
export function dashscopeProvider(
  config: TtsProviderConfig,
  apiKey: string,
): TtsProvider {
  return {
    engine: 'dashscope',
    settingsKey: `${config.model}/${config.voice}`,
    contentType: 'audio/wav',
    maxChars: MAX_CHARS,
    async synthesize(text: string): Promise<TtsSegment> {
      const response = await fetchOrRetryable(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          input: { text, voice: config.voice },
        }),
      })
      const payload = await response.json() as DashScopePayload
      if (!response.ok || (payload.code !== undefined && payload.code !== '')) {
        // 5xx/429 are the service's own transient answers; 4xx are ours to fix.
        throw new TtsError(
          `dashscope tts failed (${response.status}): ${payload.code ?? ''} ${payload.message ?? ''}`.trim(),
          response.status >= 500 || response.status === 429,
        )
      }
      const inline = payload.output?.audio?.data
      if (inline !== undefined && inline !== '') return { base64: inline, contentType: 'audio/wav' }
      const url = payload.output?.audio?.url
      if (url !== undefined) {
        const audioResponse = await fetchOrRetryable(url, { method: 'GET' })
        if (!audioResponse.ok) {
          throw new TtsError(
            `dashscope tts audio download failed (${audioResponse.status})`,
            audioResponse.status >= 500 || audioResponse.status === 429,
          )
        }
        const base64 = Buffer.from(await audioResponse.arrayBuffer()).toString('base64')
        return { base64, contentType: 'audio/wav' }
      }
      throw new TtsError('dashscope tts response carried no audio', false)
    },
  }
}
