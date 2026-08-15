/**
 * Aliyun Bailian (DashScope) TTS provider over the non-realtime multimodal
 * generation endpoint: one POST per chunk, Bearer key, Base64 audio (or a
 * 24-hour result URL) in the JSON response.
 */
import type { TtsProvider, TtsProviderConfig, TtsSegment } from './types.ts'

const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

/** Non-realtime API input limit for non-Qwen-TTS models, kept below it for margin. */
const MAX_CHARS = 550

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
 * @param apiKey - DASHSCOPE_API_KEY credential.
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
      const response = await fetch(ENDPOINT, {
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
        throw new Error(
          `dashscope tts failed (${response.status}): ${payload.code ?? ''} ${payload.message ?? ''}`.trim(),
        )
      }
      const inline = payload.output?.audio?.data
      if (inline !== undefined && inline !== '') return { base64: inline, contentType: 'audio/wav' }
      const url = payload.output?.audio?.url
      if (url !== undefined) {
        const audioResponse = await fetch(url)
        if (!audioResponse.ok) {
          throw new Error(`dashscope tts audio download failed (${audioResponse.status})`)
        }
        const base64 = Buffer.from(await audioResponse.arrayBuffer()).toString('base64')
        return { base64, contentType: 'audio/wav' }
      }
      throw new Error('dashscope tts response carried no audio')
    },
  }
}
