/**
 * Volcengine (Doubao) streaming ASR session over the V3 `sauc/bigmodel_async` WebSocket
 * endpoint. Wire contract (cross-checked against the official doc):
 * - handshake: the new console-API-Key mode authenticates with `X-Api-Key`,
 *   `X-Api-Resource-Id`, `X-Api-Request-Id`, `X-Api-Sequence: -1`, and
 *   `X-Api-Connect-Id`;
 * - client frames: 4-byte header (version/size, type/flags, serial/compression,
 *   reserved) + u32be payload size + gzip(payload); type 0x01 = JSON config,
 *   0x02 = audio (flags 0x02 marks the final empty frame);
 * - server frames: same header; type 0x0F = error (u32be code + u32be length +
 *   JSON); full frames carry u32be sequence + u32be length + JSON with
 *   `result.utterances[]` (`definite` false = partial, true = committed).
 *   The sequence field is present only when flag 0x01 is set: bigasr 1.0's
 *   opening frame (a bare result frame, no code ack) sends flags 0, so its
 *   payload starts after the header + size at offset 8.
 */
import { gzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { AsrEvent, AsrSession } from './types.ts'

const ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'

/** Init-ack success code the service answers on the config frame. */
const OK_CODE = 1000

/** Per-result code meaning "no valid speech in this window"; not an error. */
const NO_VOICE_CODE = 1013

/** Server JSON of one frame (only the fields read). */
interface AsrPayload {
  readonly code?: number
  readonly result?: {
    readonly text?: string
    readonly utterances?: readonly {
      readonly text?: string
      readonly definite?: boolean
    }[]
  }
  readonly error?: string
}

/** Recognition events re-exported for the bridge's imports. */
export type { AsrEvent } from './types.ts'

/** Message-type nibbles of the protocol header. */
const MSG_FULL_CLIENT = 0x01
const MSG_AUDIO_CLIENT = 0x02
const MSG_SERVER_ERROR = 0x0f

/** Flag bit marking a server frame that carries a u32be sequence before the size. */
const FLAG_SEQUENCE = 0x01

/** Build one client frame: header + u32be size + gzip(payload). */
function frame(messageType: number, flags: number, payload: Buffer): Buffer {
  const compressed = gzipSync(payload)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(compressed.length, 0)
  // Header: version 1 / size 1, type / flags, serial JSON / compression gzip, reserved.
  return Buffer.concat([
    Buffer.from([(0x01 << 4) | 0x01, (messageType << 4) | flags, (0x01 << 4) | 0x01, 0x00]),
    size,
    compressed,
  ])
}

/** One parse outcome: an event, a swallowed no-op, or a failure diagnostic. */
type FrameOutcome = AsrEvent | { readonly type: 'ignored' } | { readonly type: 'invalid'; readonly reason: string }

/** Parse one binary server frame into its outcome. */
function parseServerFrame(data: Buffer): FrameOutcome {
  if (data.length < 8) return { type: 'invalid', reason: 'frame shorter than the fixed header' }
  const messageType = data[1]! >> 4
  if (messageType === MSG_SERVER_ERROR) {
    if (data.length < 12) return { type: 'invalid', reason: 'error frame shorter than its fixed header' }
    const code = data.readUInt32BE(4)
    const message = data.subarray(12).toString('utf8')
    return { type: 'error', code: `asr-${String(code)}`, message: message.slice(0, 300) }
  }
  // The u32be sequence field rides along only when flag 0x01 is set; the
  // payload size follows it (offset 8) or sits right after the header (offset 4).
  const sizeAt = (data[1]! & FLAG_SEQUENCE) !== 0 ? 8 : 4
  if (data.length < sizeAt + 4) return { type: 'invalid', reason: 'frame shorter than the fixed header' }
  const length = data.readUInt32BE(sizeAt)
  const jsonBytes = data.subarray(sizeAt + 4, sizeAt + 4 + length)
  let payload: AsrPayload
  try {
    payload = JSON.parse(jsonBytes.toString('utf8')) as AsrPayload
  } catch {
    return { type: 'invalid', reason: 'frame carried malformed json' }
  }
  if (payload.code === NO_VOICE_CODE) return { type: 'ignored' }
  if (payload.error !== undefined) {
    return { type: 'error', code: 'asr-service', message: payload.error.slice(0, 300) }
  }
  // The init ack carries code 1000 with no result; later frames carry utterances.
  if (payload.result === undefined) {
    if ((payload.code ?? OK_CODE) === OK_CODE) return { type: 'ignored' }
    return { type: 'error', code: 'asr-init', message: `init rejected: ${String(payload.code ?? '')} ${payload.error ?? ''}`.trim() }
  }
  const first = payload.result.utterances?.find(utterance => utterance.text !== undefined && utterance.text !== '')
  if (first === undefined) return { type: 'ignored' }
  return first.definite === true
    ? { type: 'final', text: first.text! }
    : { type: 'partial', text: first.text! }
}

/**
 * One recognition session: connect, stream PCM frames, surface events.
 * Lifecycle is explicit: start() → sendAudio()* → finish() → close().
 */
export class VolcengineAsrSession implements AsrSession {
  private socket: WebSocket | undefined
  private readonly emitted: ((event: AsrEvent) => void) | undefined
  private finishing = false
  private closed = false

  /**
   * @param apiKey - console API Key (控制台 API Key 管理创建的密钥).
   * @param resourceId - ASR resource id selecting the model version and billing
   * mode (e.g. `volc.seedasr.sauc.duration`).
   * @param emit - receives recognition events after start() resolves.
   * @param onDone - invoked once when the provider socket closes after the
   * init ack (the natural end after finish(): the last result is delivered).
   */
  constructor(
    private readonly apiKey: string,
    private readonly resourceId: string,
    emit?: (event: AsrEvent) => void,
    onDone?: () => void,
  ) {
    this.emitted = emit
    this.done = onDone
  }

  private readonly done: (() => void) | undefined
  private notifiedDone = false

  /** Connect, send the config frame, and wait for the service's ack. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settled = { done: false }
      const requestId = randomUUID()
      const socket = new WebSocket(ENDPOINT, {
        headers: {
          'X-Api-Key': this.apiKey,
          'X-Api-Resource-Id': this.resourceId,
          'X-Api-Request-Id': requestId,
          'X-Api-Sequence': '-1',
          'X-Api-Connect-Id': randomUUID(),
        },
      })
      this.socket = socket
      const fail = (message: string): void => {
        if (settled.done) return
        settled.done = true
        reject(new Error(message))
      }
      socket.on('unexpected-response', (_request, response) => {
        fail(`asr handshake rejected (http ${String(response.statusCode)})`)
      })
      socket.on('error', error => { fail(`asr socket error: ${error.message}`) })
      socket.on('open', () => {
        socket.send(frame(MSG_FULL_CLIENT, 0x00, Buffer.from(JSON.stringify({
          user: { uid: 'dsh-speech-plugin' },
          request: {
            reqid: requestId,
            workflow: 'audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate',
            show_utterances: true,
            result_type: 'single',
            sequence: 1,
          },
          audio: { format: 'pcm', codec: 'pcm', rate: 16000, bits: 16, channel: 1, sample_rate: 16000 },
        }))))
      })
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return
        const outcome = parseServerFrame(data)
        if (!settled.done) {
          if (outcome.type === 'error' || outcome.type === 'invalid') {
            socket.close()
            fail(outcome.type === 'error' ? `${outcome.code}: ${outcome.message}` : outcome.reason)
            return
          }
          settled.done = true
          this.emitted?.({ type: 'ready' })
          resolve()
          return
        }
        if (outcome.type === 'ready' || outcome.type === 'ignored') return
        if (outcome.type === 'invalid') {
          this.emitted?.({ type: 'error', code: 'asr-frame', message: outcome.reason })
          return
        }
        this.emitted?.(outcome)
      })
      socket.on('close', () => {
        if (!settled.done) {
          fail('asr socket closed before the init ack')
          return
        }
        if (!this.notifiedDone) {
          this.notifiedDone = true
          this.done?.()
        }
      })
    })
  }

  /** Forward one PCM16/16k/mono chunk. No-op after finish() or before the socket opens. */
  sendAudio(pcm: Buffer): void {
    if (this.closed || this.finishing) return
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(frame(MSG_AUDIO_CLIENT, 0x00, pcm))
  }

  /** Send the final empty frame; the service answers the last result, then EOF. */
  finish(): void {
    if (this.finishing || this.closed) return
    this.finishing = true
    this.socket?.send(frame(MSG_AUDIO_CLIENT, 0x02, Buffer.alloc(0)))
  }

  /** Drop the connection without the end-of-stream handshake. */
  close(): void {
    this.closed = true
    this.socket?.close()
  }
}
