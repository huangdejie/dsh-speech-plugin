/**
 * Volcengine (Doubao) TTS provider over the V1 non-streaming HTTP endpoint:
 * one POST per chunk, `Bearer;<token>` authorization, Base64 MP3 in the JSON
 * response. The V1 shape is marked legacy in favor of the V3 SSE API, but it
 * is the simplest request/response contract and fits non-streaming playback.
 */
import { randomUUID } from 'node:crypto'
import type { TtsProvider, TtsProviderConfig, TtsSegment } from './types.ts'

const ENDPOINT = 'https://openspeech.bytedance.com/api/v1/tts'

/** 1024 UTF-8 bytes per request; 280 chars stay under it even in pure CJK. */
const MAX_CHARS = 280

/** V1 response payload shape (only the fields read). */
interface VolcenginePayload {
  readonly code?: number
  readonly message?: string
  readonly data?: string
}

/** Build the Volcengine provider.
 * @param config - voice/model settings (model may be the empty service default).
 * @param appId - console application id.
 * @param accessToken - VOLCENGINE_TTS_ACCESS_TOKEN credential.
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
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          // The V1 wire format separates the scheme and token with a semicolon.
          authorization: `Bearer;${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          app: { appid: appId, token: 'dsh-speech-plugin', cluster: 'volcano_tts' },
          user: { uid: 'dsh-speech-plugin' },
          audio: { voice_type: config.voice, encoding: 'mp3' },
          request: {
            reqid: randomUUID(),
            text,
            operation: 'query',
            ...(config.model === '' ? {} : { model: config.model }),
          },
        }),
      })
      const payload = await response.json() as VolcenginePayload
      if (!response.ok || payload.code !== 3000) {
        throw new Error(
          `volcengine tts failed (${String(payload.code ?? response.status)}): ${payload.message ?? ''}`.trim(),
        )
      }
      if (payload.data === undefined || payload.data === '') {
        throw new Error('volcengine tts response carried no audio')
      }
      return { base64: payload.data, contentType: 'audio/mpeg' }
    },
  }
}
