/**
 * Volcengine (Doubao) TTS provider over the V3 unidirectional HTTP endpoint:
 * one POST per chunk, `X-Api-App-Id`/`X-Api-Access-Key`/`X-Api-Resource-Id`
 * headers, and a newline-delimited JSON stream whose `data` fields carry
 * Base64 MP3 until the `20000000` completion block. The resource id selects
 * the model version (`seed-tts-2.0` for 语音合成大模型 2.0, the service the
 * console opens today — the legacy V1 API cannot see that authorization).
 */
import { TtsError, type TtsProvider, type TtsProviderConfig, type TtsSegment } from './types.ts'

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'

/** V3 request text budget; kept conservative for CJK-heavy text. */
const MAX_CHARS = 280

/** One chunk synthesis budget; timeouts are transient by nature. */
const REQUEST_TIMEOUT_MS = 30_000

/** Stream completion code carried by the final JSON block. */
const COMPLETION_CODE = 20000000

/** One JSON block of the response stream. */
interface VolcengineBlock {
  readonly code?: number
  readonly message?: string
  readonly data?: string | null
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
 * @param config - voice settings plus the resource id selecting the model.
 * @param appId - console application id.
 * @param accessToken - console access token.
 */
export function volcengineProvider(
  config: TtsProviderConfig,
  appId: string,
  accessToken: string,
): TtsProvider {
  return {
    engine: 'volcengine',
    settingsKey: `${appId}/${config.voice}/${config.model}`,
    contentType: 'audio/mpeg',
    maxChars: MAX_CHARS,
    async synthesize(text: string): Promise<TtsSegment> {
      const response = await fetchOrRetryable(ENDPOINT, {
        method: 'POST',
        headers: {
          'X-Api-App-Id': appId,
          'X-Api-Access-Key': accessToken,
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
          message = (JSON.parse(body) as VolcengineBlock).message ?? message
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
