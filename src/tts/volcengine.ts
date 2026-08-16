/**
 * Volcengine (Doubao) TTS provider over the V3 unidirectional HTTP endpoint:
 * one POST per chunk, authenticated by a console API Key (`X-Api-Key` — the
 * per-app Access Token of the legacy V1 API is not accepted here), with
 * `X-Api-Resource-Id` selecting the model version and a newline-delimited
 * JSON stream whose `data` fields carry Base64 MP3 until the `20000000`
 * completion block. The speaker must belong to the granted resource: 2.0
 * voices under `seed-tts-2.0`, public voices under `volc.service_type.10029`.
 */
import { TtsError, type TtsProvider, type TtsProviderConfig, type TtsSegment } from './types.ts'

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'

/** V3 request text budget; kept conservative for CJK-heavy text. */
const MAX_CHARS = 280

/** One chunk synthesis budget; timeouts are transient by nature. */
const REQUEST_TIMEOUT_MS = 30_000

/** Stream completion code carried by the final JSON block. */
const COMPLETION_CODE = 20000000

/** One JSON block of the response stream (audio/finish or an error envelope). */
interface VolcengineBlock {
  readonly code?: number
  readonly message?: string
  readonly data?: string | null
  readonly header?: {
    readonly code?: number
    readonly message?: string
  }
}

/** Run one fetch, classifying network and timeout throws as retryable. */
async function fetchOrRetryable(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw new TtsError(
      `volcengine tts request failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    )
  }
}

/**
 * Build the Volcengine V3 provider.
 * @param config - voice plus the resource id selecting the model.
 * @param apiKey - console API Key (控制台 API Key 管理创建的密钥).
 */
export function volcengineProvider(
  config: TtsProviderConfig,
  apiKey: string,
): TtsProvider {
  return {
    engine: 'volcengine',
    settingsKey: `${config.model}/${config.voice}`,
    contentType: 'audio/mpeg',
    maxChars: MAX_CHARS,
    async synthesize(text: string): Promise<TtsSegment> {
      const response = await fetchOrRetryable(ENDPOINT, {
        method: 'POST',
        headers: {
          'X-Api-Key': apiKey,
          'X-Api-Resource-Id': config.model,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          user: { uid: 'dsh-speech-plugin' },
          req_params: {
            text,
            speaker: config.voice,
            audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: 0 },
          },
        }),
      })
      if (!response.ok) {
        const body = await response.text()
        let message = body.slice(0, 200)
        try {
          const parsed = JSON.parse(body) as VolcengineBlock
          message = parsed.message ?? parsed.header?.message ?? message
        } catch {
          // Non-JSON error body keeps its truncated text form.
        }
        throw new TtsError(
          `volcengine tts failed (${response.status}): ${message}`,
          response.status >= 500 || response.status === 429,
        )
      }
      const parts: string[] = []
      for (const line of (await response.text()).split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let block: VolcengineBlock
        try {
          block = JSON.parse(trimmed) as VolcengineBlock
        } catch {
          throw new TtsError(`volcengine tts stream carried a malformed block: ${trimmed.slice(0, 120)}`, false)
        }
        // Error envelopes nest the diagnostic under `header` and may arrive
        // with HTTP 200, so the top-level codes below are not the whole story.
        if (block.header !== undefined) {
          throw new TtsError(
            `volcengine tts failed (${String(block.header.code ?? 'unknown')}): ${block.header.message ?? ''}`.trim(),
            false,
          )
        }
        if (block.code === 0) {
          if (typeof block.data === 'string' && block.data !== '') parts.push(block.data)
          continue
        }
        if (block.code === COMPLETION_CODE) break
        throw new TtsError(
          `volcengine tts failed (${String(block.code ?? 'unknown')}): ${block.message ?? ''}`.trim(),
          false,
        )
      }
      if (parts.length === 0) {
        throw new TtsError('volcengine tts response carried no audio', false)
      }
      // One part per request: the browser plays parts sequentially, so a
      // single concatenated MP3 keeps chunk and part boundaries aligned.
      return { base64: parts.join(''), contentType: 'audio/mpeg' }
    },
  }
}
