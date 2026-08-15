/**
 * Browser-local speech controller for one Session. Playback prefers the
 * Host's cloud TTS route (sequential Base64 parts through Audio elements);
 * when the route is unavailable (no credentials, offline) it falls back to
 * the Web Speech API. `toggle` stays the single seam every caller uses, so a
 * provider swap never touches the buttons or the auto-announce watcher.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import { cleanTextForSpeech } from './clean-text.ts'

/** Host route answering cloud synthesis; same origin as the chat UI. */
const TTS_ROUTE = '/dsh-speech/tts'

/** Immutable view published to every speech control in one Session. */
export interface SpeechView {
  /** Message currently being spoken, or null when idle. */
  speakingMessageId: MessageId | null
}

const IDLE: SpeechView = Object.freeze({ speakingMessageId: null })

/** Successful route answer: ordered Base64 audio parts. */
interface TtsOk {
  readonly ok: true
  readonly engine: string
  readonly contentType: string
  readonly parts: readonly string[]
}

/** Failed route answer. */
interface TtsFail {
  readonly ok: false
  readonly code: string
}

/** Pick a voice matching the UI language, tolerating an initially empty voices list. */
function pickVoice(): SpeechSynthesisVoice | undefined {
  const wanted = document.documentElement.lang || navigator.language || 'zh'
  const prefix = wanted.split('-')[0]!.toLowerCase()
  return window.speechSynthesis.getVoices().find(
    voice => voice.lang.toLowerCase().startsWith(prefix),
  )
}

/** Decode one Base64 part into a Blob for an Audio element. */
function partBlob(base64: string, contentType: string): Blob {
  const bytes = atob(base64)
  const buffer = new Uint8Array(bytes.length)
  for (let index = 0; index < bytes.length; index += 1) buffer[index] = bytes.charCodeAt(index)
  return new Blob([buffer], { type: contentType })
}

/**
 * Per-session speech object layer: every message button in one Session shares
 * one instance, so `toggle` is the single authority over what is speaking.
 * In-flight playback is canceled by bumping `generation`; every async step
 * re-checks it, so a replaced or stopped playback never publishes stale state.
 */
export class SpeechController implements HostObservable<SpeechView> {
  private view = IDLE
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private audio: HTMLAudioElement | undefined
  private disposed = false

  /** Return the cached immutable view. */
  getSnapshot = (): SpeechView => this.view

  /** Subscribe to view replacement. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Speak one message's text (markdown stripped here), replacing anything
   * already speaking; speaking the message already in flight stops it. Empty
   * or code-only text is a no-op.
   * @param messageId - target assistant message.
   * @param text - raw text blocks of that message.
   */
  toggle(messageId: MessageId, text: string): void {
    if (this.disposed) return
    if (this.view.speakingMessageId === messageId) {
      this.stop()
      return
    }
    const cleaned = cleanTextForSpeech(text)
    if (cleaned === '') return
    this.stop()
    this.publish({ speakingMessageId: messageId })
    const generation = this.generation
    void this.playCloud(messageId, cleaned, generation)
  }

  /** Stop any in-flight speech, cloud or system. */
  stop(): void {
    this.generation += 1
    if (this.audio !== undefined) {
      this.audio.pause()
      this.audio = undefined
    }
    if (typeof speechSynthesis !== 'undefined') window.speechSynthesis.cancel()
    this.publish(IDLE)
  }

  /** Stop speech and drop subscribers when the owning fiber unloads. */
  dispose(): void {
    this.disposed = true
    this.stop()
    this.listeners.clear()
  }

  /** Try the cloud route; on any unavailability fall back to system voices. */
  private async playCloud(messageId: MessageId, text: string, generation: number): Promise<void> {
    try {
      const response = await fetch(TTS_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (generation !== this.generation) return
      const payload = await response.json() as TtsOk | TtsFail
      if (!response.ok || !payload.ok) {
        this.playSystem(messageId, text)
        return
      }
      for (const part of payload.parts) {
        if (generation !== this.generation) return
        const url = URL.createObjectURL(partBlob(part, payload.contentType))
        try {
          await this.playUrl(url, generation)
        } finally {
          URL.revokeObjectURL(url)
        }
      }
      this.publishIdle(messageId)
    } catch {
      // Offline or route failure: system voices still work.
      if (generation === this.generation) this.playSystem(messageId, text)
    }
  }

  /** Play one object URL to its end; resolves early once superseded. */
  private playUrl(url: string, generation: number): Promise<void> {
    return new Promise(resolve => {
      const audio = new Audio(url)
      this.audio = audio
      const settle = (): void => {
        if (this.audio === audio) this.audio = undefined
        resolve()
      }
      audio.onended = settle
      audio.onerror = settle
      void audio.play().catch(settle)
      if (generation !== this.generation) {
        audio.pause()
        settle()
      }
    })
  }

  /** Web Speech API path: one utterance for the whole text. */
  private playSystem(messageId: MessageId, text: string): void {
    if (typeof speechSynthesis === 'undefined') {
      this.publishIdle(messageId)
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    const voice = pickVoice()
    if (voice !== undefined) utterance.voice = voice
    utterance.lang = voice?.lang ?? navigator.language
    // A canceled utterance also fires end/error; the identity guard keeps a
    // late event from clearing the view of the utterance that replaced it.
    utterance.onend = () => { this.publishIdle(messageId) }
    utterance.onerror = () => { this.publishIdle(messageId) }
    window.speechSynthesis.speak(utterance)
  }

  /** Clear the view only when the finished playback still owns it. */
  private publishIdle(messageId: MessageId): void {
    if (this.disposed || this.view.speakingMessageId !== messageId) return
    this.publish(IDLE)
  }

  /** Replace the view and contain subscriber failures at the observable boundary. */
  private publish(view: SpeechView): void {
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
