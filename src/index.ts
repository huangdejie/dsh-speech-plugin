/**
 * Speech plugin, node half: registers the durable `ui-speech` settings
 * section and the cloud-TTS route (`/dsh-speech/tts`) when its Host services
 * are composed. Credentials stay in this process's environment and never
 * reach the browser. The browser half ships as exports["./client"], discovered
 * through this package's `dsh.client` declaration.
 */
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
// Type-only: pulls the webServer Context merge (ctx.webServer) and WebRoute.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, DEFAULT_CONFIG, type SpeechPluginConfig } from './config.ts'
import { SPEECH_SETTINGS_NAMESPACE, SpeechSettingsSchema } from './speech-settings.ts'
import { SpeechTTSService } from './tts/service.ts'

export { Config }
export {
  ANNOUNCE_FIELD, ANNOUNCE_MODES, DEFAULT_ANNOUNCE_MODE, SPEECH_SETTINGS_NAMESPACE,
  SpeechSettingsSchema, type AnnounceMode, type SpeechSettings,
} from './speech-settings.ts'
export type { SpeechEngine, SpeechPluginConfig } from './config.ts'

const SPEECH_NAMESPACE = settingsNamespace(SPEECH_SETTINGS_NAMESPACE)

const ROUTE_PATH = '/dsh-speech/tts'

/** Route request body: the cleaned text to synthesize. */
interface TtsRequestBody {
  readonly text?: unknown
}

/** Refuse bodies above this size; a message within maxTextLength fits far below it. */
const MAX_BODY_BYTES = 1024 * 1024

/** Read one JSON request body, refusing oversized bodies. */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * Register the durable speech section and the TTS route when their Host
 * services are composed.
 * @param ctx - Host context that may acquire the settings and HTTP services.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: SpeechPluginConfig = DEFAULT_CONFIG): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SPEECH_NAMESPACE, SpeechSettingsSchema)
  })

  ctx.inject(['webServer'], (httpCtx) => {
    const service = new SpeechTTSService(config)
    const log = (message: string): void => {
      httpCtx.logger.info(`dsh-speech: ${message}`)
    }
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (request, response): Promise<void> => {
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, code: 'method-not-allowed' }))
          return
        }
        let body: TtsRequestBody
        try {
          body = await readBody(request) as TtsRequestBody
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, code: 'invalid-json' }))
          return
        }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, code: 'empty-text' }))
          return
        }
        if (text.length > config.maxTextLength) {
          response.writeHead(413, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, code: 'text-too-long' }))
          return
        }
        const described = service.describe()
        if (described === undefined) {
          response.writeHead(503, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, code: 'tts-unavailable' }))
          return
        }
        // NDJSON stream: one JSON line per audio part as it is synthesized, so
        // playback starts with the first chunk instead of after the whole
        // message. Validation failures above stay plain JSON status answers.
        response.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-store',
        })
        response.write(`${JSON.stringify({ engine: described.engine, contentType: described.contentType })}\n`)
        try {
          for await (const part of service.synthesizeParts(text)) {
            response.write(`${JSON.stringify({ part })}\n`)
          }
          response.write(`${JSON.stringify({ done: true })}\n`)
        } catch (error) {
          // A mid-stream failure ends the stream with an error line; parts
          // already sent (and possibly played) are kept, the rest are dropped.
          const message = error instanceof Error ? error.message : String(error)
          httpCtx.logger.warn(`dsh-speech: tts synthesis failed: ${message}`)
          response.write(`${JSON.stringify({ error: { code: 'tts-failed', message } })}\n`)
        }
        response.end()
      },
    }), 'dsh-speech: tts route')
    if (service.available()) {
      log(`cloud TTS route mounted at ${ROUTE_PATH}`)
    } else {
      log(`no cloud TTS credentials; ${ROUTE_PATH} answers 503 and the browser uses system voices`)
    }
  })
}
