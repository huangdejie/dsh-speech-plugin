/**
 * Browser-side microphone recorder for voice input: captures 16 kHz mono
 * PCM16 through a ScriptProcessor and streams it over the plugin's ASR
 * WebSocket, surfacing recognition events and connection state.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Host ASR socket path on the page's own origin. */
function asrUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/dsh-speech/asr`
}

/** Live recorder view rendered by the mic button. */
export interface MicView {
  /** Idle, connecting, live, or failed with a surfaced reason. */
  status: 'idle' | 'connecting' | 'recording' | 'error'
  /** Failure diagnostic for the tooltip while status is 'error'. */
  error: string | null
}

/** Recognition text callbacks handed in by the button (it owns the draft). */
export interface MicTextHandlers {
  /** One in-progress utterance replacement (the current tail). */
  onPartial: (text: string) => void
  /** One committed utterance (append). */
  onFinal: (text: string) => void
  /** The stream ended (stop, provider close, or failure after text). */
  onDone: () => void
}

const IDLE: MicView = Object.freeze({ status: 'idle', error: null })

/** Convert one Float32 chunk to 16 kHz mono PCM16, averaging on downsample. */
function toPcm16(input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === 16000) {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i += 1) out[i] = Math.max(-32768, Math.min(32767, Math.round(input[i]! * 32768)))
    return out
  }
  const ratio = inputRate / 16000
  const outLength = Math.floor(input.length / ratio)
  const out = new Int16Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += input[j]!
    const avg = sum / Math.max(1, end - start)
    out[i] = Math.max(-32768, Math.min(32767, Math.round(avg * 32768)))
  }
  return out
}

/**
 * One recording session owner: starts capture and the ASR socket, forwards
 * audio, and publishes connection state. stop() finalizes; dispose() aborts.
 */
export class MicRecorder implements HostObservable<MicView> {
  private view = IDLE
  private readonly listeners = new Set<() => void>()
  private socket: WebSocket | undefined
  private audioContext: AudioContext | undefined
  private stream: MediaStream | undefined
  private processor: ScriptProcessorNode | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private handlers: MicTextHandlers | undefined
  private disposed = false

  /** Return the cached immutable view. */
  getSnapshot = (): MicView => this.view

  /** Subscribe to view replacement. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Begin one recording; replaces any in-flight session.
   * @param handlers - recognition text callbacks owned by the caller.
   */
  async start(handlers: MicTextHandlers): Promise<void> {
    this.cancel()
    if (this.disposed) return
    this.handlers = handlers
    this.publish({ status: 'connecting', error: null })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      if (this.disposed || this.handlers !== handlers) {
        stream.getTracks().forEach(track => { track.stop() })
        return
      }
      this.stream = stream
      const audioContext = new AudioContext()
      this.audioContext = audioContext
      const source = audioContext.createMediaStreamSource(stream)
      this.source = source
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      this.processor = processor

      const socket = new WebSocket(asrUrl())
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      socket.onopen = (): void => {
        // Text flows once the host relays the provider's ready event.
      }
      socket.onmessage = (event: MessageEvent): void => {
        if (typeof event.data !== 'string') return
        let message: { type?: string; text?: string; code?: string; message?: string }
        try {
          message = JSON.parse(event.data) as typeof message
        } catch {
          return
        }
        switch (message.type) {
          case 'ready':
            if (this.view.status !== 'error') this.publish({ status: 'recording', error: null })
            break
          case 'partial':
            if (message.text !== undefined) this.handlers?.onPartial(message.text)
            break
          case 'final':
            if (message.text !== undefined) this.handlers?.onFinal(message.text)
            break
          case 'error':
            console.warn(`[dsh-speech] voice input failed (${message.code ?? ''}: ${message.message ?? ''})`)
            this.publish({ status: 'error', error: message.message ?? message.code ?? 'voice input failed' })
            this.cleanupCapture()
            this.handlers?.onDone()
            this.closeSocket()
            break
          case 'done':
            this.handlers?.onDone()
            this.finishView()
            break
          default:
            break
        }
      }
      socket.onclose = (): void => {
        if (this.view.status === 'connecting' || this.view.status === 'recording') {
          this.handlers?.onDone()
          this.finishView()
        }
      }
      socket.onerror = (): void => {
        if (this.view.status === 'connecting' || this.view.status === 'recording') {
          this.publish({ status: 'error', error: 'voice input connection failed' })
          this.handlers?.onDone()
          this.cleanupCapture()
        }
      }

      // Audio flows only after the socket opens; before that, frames are
      // dropped by the send guard (bufferedAmount check keeps it simple).
      processor.onaudioprocess = (event: AudioProcessingEvent): void => {
        if (socket.readyState !== WebSocket.OPEN) return
        const pcm = toPcm16(event.inputBuffer.getChannelData(0), audioContext.sampleRate)
        socket.send(pcm.buffer as ArrayBuffer)
      }
      source.connect(processor)
      processor.connect(audioContext.destination)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[dsh-speech] microphone unavailable: ${message}`)
      this.publish({ status: 'error', error: message })
      this.handlers?.onDone()
      this.cleanupCapture()
    }
  }

  /** Finalize: stop capture and tell the host to flush the last utterance. */
  stop(): void {
    this.cleanupCapture()
    if (this.socket !== undefined && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'stop' }))
    }
  }

  /** Abort everything (plugin unload). */
  dispose(): void {
    this.disposed = true
    this.cancel()
    this.listeners.clear()
  }

  /**
   * Drop the session without the end-of-stream flush: capture and socket go,
   * callbacks detach, and no late final can land in the draft afterwards.
   */
  cancel(): void {
    this.cleanupCapture()
    this.closeSocket()
    this.handlers = undefined
    this.publish(IDLE)
  }

  private finishView(): void {
    this.cleanupCapture()
    this.closeSocket()
    this.publish(IDLE)
  }

  private closeSocket(): void {
    if (this.socket !== undefined) {
      this.socket.onmessage = null
      this.socket.onclose = null
      this.socket.onerror = null
      this.socket.close()
      this.socket = undefined
    }
  }

  private cleanupCapture(): void {
    if (this.processor !== undefined) {
      this.processor.onaudioprocess = null
      this.processor.disconnect()
      this.processor = undefined
    }
    this.source?.disconnect()
    this.source = undefined
    void this.audioContext?.close().catch(() => {})
    this.audioContext = undefined
    this.stream?.getTracks().forEach(track => { track.stop() })
    this.stream = undefined
  }

  /** Replace the view and contain subscriber failures at the boundary. */
  private publish(view: MicView): void {
    this.view = Object.freeze(view)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-speech] subscriber threw:', error)
      }
    }
  }
}
