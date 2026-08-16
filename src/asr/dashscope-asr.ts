/**
 * Aliyun Bailian (DashScope) realtime ASR session over the Paraformer duplex
 * WebSocket endpoint. Wire contract (cross-checked against the official doc):
 * - handshake authenticates with an `Authorization: Bearer <key>` header;
 * - client messages are JSON text: run-task starts the task (model + audio
 *   format), finish-task ends it; audio rides raw binary frames in between;
 * - server events are JSON text: task-started (ready), result-generated with
 *   `payload.output.sentence` (`sentence_end` false = partial, true =
 *   committed; `heartbeat` sentences are silence keep-alives to skip),
 *   task-finished (natural end), task-failed (`header.error_code` /
 *   `error_message`).
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { AsrEvent, AsrSession } from './types.ts'

const ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'

/** Server JSON of one event (only the fields read). */
interface ServerEvent {
  readonly header?: {
    readonly event?: string
    readonly error_code?: string
    readonly error_message?: string
  }
  readonly payload?: {
    readonly output?: {
      readonly sentence?: {
        readonly text?: string
        readonly sentence_end?: boolean
        readonly heartbeat?: boolean
      }
    }
  }
}

/**
 * One recognition session: connect, stream PCM frames, surface events.
 * Lifecycle is explicit: start() → sendAudio()* → finish() → close().
 */
export class DashscopeAsrSession implements AsrSession {
  private socket: WebSocket | undefined
  private taskId = ''
  private readonly emitted: ((event: AsrEvent) => void) | undefined
  private finishing = false
  private closed = false

  /**
   * @param apiKey - DashScope API Key (`sk-` prefixed, from the Bailian console).
   * @param model - realtime ASR model name (e.g. `paraformer-realtime-v2`).
   * @param emit - receives recognition events after start() resolves.
   * @param onDone - invoked once when the task finishes (the natural end after
   * finish(): the last result is delivered) or the socket closes.
   */
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    emit?: (event: AsrEvent) => void,
    onDone?: () => void,
  ) {
    this.emitted = emit
    this.done = onDone
  }

  private readonly done: (() => void) | undefined
  private notifiedDone = false

  /** Connect, run the task, and wait for the service's task-started event. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settled = { done: false }
      this.taskId = randomUUID()
      const socket = new WebSocket(ENDPOINT, {
        headers: { authorization: `Bearer ${this.apiKey}` },
      })
      this.socket = socket
      const fail = (message: string): void => {
        if (settled.done) return
        settled.done = true
        reject(new Error(message))
      }
      const notifyDone = (): void => {
        if (this.notifiedDone) return
        this.notifiedDone = true
        this.done?.()
      }
      socket.on('unexpected-response', (_request, response) => {
        fail(`asr handshake rejected (http ${String(response.statusCode)})`)
      })
      socket.on('error', error => { fail(`asr socket error: ${error.message}`) })
      socket.on('open', () => {
        socket.send(JSON.stringify({
          header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: this.model,
            // heartbeat keeps the connection alive through long mid-recording
            // pauses; heartbeat sentences are skipped on arrival below.
            parameters: { format: 'pcm', sample_rate: 16000, heartbeat: true },
            input: {},
          },
        }))
      })
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return
        let event: ServerEvent
        try {
          event = JSON.parse(data.toString('utf8')) as ServerEvent
        } catch {
          return
        }
        switch (event.header?.event) {
          case 'task-started':
            if (!settled.done) {
              settled.done = true
              this.emitted?.({ type: 'ready' })
              resolve()
            }
            break
          case 'result-generated': {
            const sentence = event.payload?.output?.sentence
            if (sentence === undefined || sentence.heartbeat === true) break
            if (sentence.text === undefined || sentence.text === '') break
            this.emitted?.(sentence.sentence_end === true
              ? { type: 'final', text: sentence.text }
              : { type: 'partial', text: sentence.text })
            break
          }
          case 'task-failed': {
            const code = `asr-${event.header?.error_code ?? 'failed'}`
            const message = (event.header?.error_message ?? '').slice(0, 300)
            if (!settled.done) {
              socket.close()
              fail(`${code}: ${message}`)
              return
            }
            this.emitted?.({ type: 'error', code, message })
            notifyDone()
            break
          }
          case 'task-finished':
            notifyDone()
            socket.close()
            break
          default:
            break
        }
      })
      socket.on('close', () => {
        if (!settled.done) {
          fail('asr socket closed before the task started')
          return
        }
        notifyDone()
      })
    })
  }

  /** Forward one PCM16/16k/mono chunk as a raw binary frame. No-op after finish() or before the task starts. */
  sendAudio(pcm: Buffer): void {
    if (this.closed || this.finishing) return
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(pcm)
  }

  /** End the audio stream; the service answers the last result, then task-finished. */
  finish(): void {
    if (this.finishing || this.closed) return
    this.finishing = true
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({
      header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
      payload: { input: {} },
    }))
  }

  /** Drop the connection without the end-of-stream handshake. */
  close(): void {
    this.closed = true
    this.socket?.close()
  }
}
