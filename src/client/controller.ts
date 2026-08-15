/**
 * Browser-local speech controller for one Session: wraps the Web Speech API
 * so one message speaks at a time, publishing a small observable view the
 * per-message buttons render from. The seam is deliberately one method — a
 * future cloud-TTS provider replaces these internals only.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'

/** Immutable view published to every speech control in one Session. */
export interface SpeechView {
  /** Message currently being spoken, or null when idle. */
  speakingMessageId: MessageId | null
}

const IDLE: SpeechView = Object.freeze({ speakingMessageId: null })

/** Pick a voice matching the UI language, tolerating an initially empty voices list. */
function pickVoice(): SpeechSynthesisVoice | undefined {
  const wanted = document.documentElement.lang || navigator.language || 'zh'
  const prefix = wanted.split('-')[0]!.toLowerCase()
  return window.speechSynthesis.getVoices().find(
    voice => voice.lang.toLowerCase().startsWith(prefix),
  )
}

/**
 * Per-session speech object layer: every message button in one Session shares
 * one instance, so `toggle` is the single authority over what is speaking.
 */
export class SpeechController implements HostObservable<SpeechView> {
  private view = IDLE
  private readonly listeners = new Set<() => void>()
  private disposed = false

  /** Return the cached immutable view. */
  getSnapshot = (): SpeechView => this.view

  /** Subscribe to view replacement. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Speak one message's text, replacing anything already speaking; speaking
   * the message already in flight stops it. Empty text is a no-op.
   * @param messageId - target assistant message.
   * @param text - plain text blocks of that message.
   */
  toggle(messageId: MessageId, text: string): void {
    if (this.disposed) return
    if (this.view.speakingMessageId === messageId) {
      this.stop()
      return
    }
    const trimmed = text.trim()
    if (trimmed === '') return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(trimmed)
    const voice = pickVoice()
    if (voice !== undefined) utterance.voice = voice
    utterance.lang = voice?.lang ?? navigator.language
    // A canceled utterance also fires end/error; the identity guard keeps a
    // late event from clearing the view of the utterance that replaced it.
    utterance.onend = () => { this.publishIdle(messageId) }
    utterance.onerror = () => { this.publishIdle(messageId) }
    this.publish({ speakingMessageId: messageId })
    window.speechSynthesis.speak(utterance)
  }

  /** Stop any in-flight speech. */
  stop(): void {
    window.speechSynthesis.cancel()
    this.publish(IDLE)
  }

  /** Stop speech and drop subscribers when the owning fiber unloads. */
  dispose(): void {
    this.disposed = true
    this.stop()
    this.listeners.clear()
  }

  /** Clear the view only when the finished utterance still owns it. */
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
