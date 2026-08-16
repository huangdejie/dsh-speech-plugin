/**
 * Speech plugin, node half: the cloud-TTS route (`/dsh-speech/tts`). Provider
 * credentials stay in this process's environment and never reach the browser;
 * the announce preference is browser-local (see the client half). The browser
 * half ships as exports["./client"], discovered through this package's
 * `dsh.client` declaration.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer) and WebRoute.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, DEFAULT_CONFIG, type SpeechPluginConfig, type AsrEngine } from './config.ts'
import { SpeechTTSService, dashscopeApiKey, volcengineApiKey } from './tts/service.ts'
import { DashscopeAsrSession } from './asr/dashscope-asr.ts'
import { VolcengineAsrSession } from './asr/volcengine-asr.ts'
import type { AsrEvent, AsrSession } from './asr/types.ts'

export { Config }
export type { SpeechEngine, SpeechPluginConfig } from './config.ts'

const ROUTE_PATH = '/dsh-speech/tts'

/** Route answering whether voice input can run (drives the mic button's state). */
const ASR_AVAILABLE_PATH = '/dsh-speech/asr/available'

/** Browser-facing WebSocket upgrade path carrying the recognition stream. */
const ASR_WS_PATH = '/dsh-speech/asr'

/**
 * Resolve the ASR provider under the configured engine and present
 * credentials. 'auto' prefers DashScope, then Volcengine — mirroring the TTS
 * engine's own resolution order, but independently of it.
 * @param config - resolved plugin configuration.
 * @param emit - recognition event sink of the created session.
 * @param onDone - natural-end callback of the created session.
 */
function resolveAsrSession(
  config: SpeechPluginConfig,
  emit: (event: AsrEvent) => void,
  onDone: () => void,
): { session: AsrSession } | { reason: string } {
  const want: readonly AsrEngine[] = config.asrEngine === 'auto'
    ? ['dashscope', 'volcengine']
    : [config.asrEngine]
  for (const engine of want) {
    if (engine === 'off') break
    if (engine === 'dashscope') {
      const apiKey = dashscopeApiKey()
      if (apiKey !== undefined) {
        return { session: new DashscopeAsrSession(apiKey, config.dashscopeAsrModel, emit, onDone) }
      }
      if (config.asrEngine === 'dashscope') {
        return { reason: 'asrEngine is dashscope but no DashScope API Key is set' }
      }
    } else {
      const apiKey = volcengineApiKey()
      if (apiKey !== undefined) {
        return { session: new VolcengineAsrSession(apiKey, config.volcengineAsrResourceId, emit, onDone) }
      }
      if (config.asrEngine === 'volcengine') {
        return { reason: 'asrEngine is volcengine but no Volcengine API Key is set' }
      }
    }
  }
  return {
    reason: config.asrEngine === 'off'
      ? 'asrEngine is off; voice input is disabled'
      : 'no ASR credentials; set DASHSCOPE_API_KEY or a Volcengine API Key',
  }
}

/**
 * Voice input availability under the ASR engine selector and present
 * credentials; instantiating a session makes no connection before start().
 */
function asrAvailability(config: SpeechPluginConfig): { available: boolean; reason: string } {
  const resolved = resolveAsrSession(config, () => {}, () => {})
  return 'session' in resolved
    ? { available: true, reason: '' }
    : { available: false, reason: resolved.reason }
}

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

/** Browser control message of the ASR socket (audio itself rides binary frames). */
interface AsrControl {
  readonly type?: unknown
}

/**
 * Bridge one browser recognition stream to one provider session. Binary
 * browser frames are PCM16/16k/mono; the browser's `{type:'stop'}` control
 * message finalizes; every provider event is relayed as JSON text.
 * @param client - the upgraded browser socket.
 * @param config - resolved plugin configuration.
 */
async function bridgeAsr(client: WebSocket, config: SpeechPluginConfig): Promise<void> {
  const send = (payload: Record<string, unknown>): void => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload))
  }
  const resolved = resolveAsrSession(
    config,
    event => {
      if (event.type === 'ready') send({ type: 'ready' })
      else if (event.type === 'error') send({ type: 'error', code: event.code, message: event.message })
      else send({ type: event.type, text: event.text })
    },
    () => {
      send({ type: 'done' })
      client.close()
    },
  )
  if (!('session' in resolved)) {
    send({ type: 'error', code: 'asr-unavailable', message: resolved.reason })
    client.close()
    return
  }
  const session = resolved.session
  let started = false
  const pendingAudio: Buffer[] = []
  client.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (started) {
        session.sendAudio(data)
      } else {
        pendingAudio.push(data)
      }
      return
    }
    try {
      const control = JSON.parse(data.toString('utf8')) as AsrControl
      if (control.type === 'stop') session.finish()
    } catch {
      // Malformed control frames are ignored; audio keeps flowing.
    }
  })
  client.on('close', () => { session.close() })
  client.on('error', () => { session.close() })
  try {
    await session.start()
    started = true
    for (const data of pendingAudio) session.sendAudio(data)
    pendingAudio.length = 0
  } catch (error) {
    send({ type: 'error', code: 'asr-start', message: error instanceof Error ? error.message : String(error) })
    session.close()
    client.close()
  }
}

/**
 * Register the durable speech section and the TTS route when their Host
 * services are composed.
 * @param ctx - Host context that may acquire the settings and HTTP services.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: SpeechPluginConfig = DEFAULT_CONFIG): void {
  ctx.inject(['webServer'], (httpCtx) => {
    const service = new SpeechTTSService(config)

    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: ASR_AVAILABLE_PATH,
      handler: (request, response): void => {
        if (request.method !== 'GET') {
          response.writeHead(405, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, code: 'method-not-allowed' }))
          return
        }
        const { available, reason } = asrAvailability(config)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, available, reason }))
      },
    }), 'dsh-speech: asr availability route')

    const wss: WebSocketServer = new WebSocketServer({ noServer: true })
    httpCtx.effect(() => {
      const dispose = httpCtx.webServer.registerUpgrade({
        path: ASR_WS_PATH,
        handler: (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
          wss.handleUpgrade(request, socket, head, client => { void bridgeAsr(client, config) })
        },
      })
      return () => {
        dispose()
        wss.close()
      }
    }, 'dsh-speech: asr upgrade route')

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
