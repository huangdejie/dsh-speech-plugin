/** Shared ASR provider contract: recognition events and the session face. */

/** Recognition events surfaced to the bridge. */
export type AsrEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'partial'; readonly text: string }
  | { readonly type: 'final'; readonly text: string }
  | { readonly type: 'error'; readonly code: string; readonly message: string }

/**
 * One provider recognition session: connect, stream PCM frames, surface
 * events. Lifecycle is explicit: start() → sendAudio()* → finish() → close().
 */
export interface AsrSession {
  /** Connect, start the provider task, and wait for its ready signal. */
  start(): Promise<void>
  /** Forward one PCM16/16k/mono chunk. No-op after finish() or before the task starts. */
  sendAudio(pcm: Buffer): void
  /** End the audio stream; the provider answers the last result, then ends the task. */
  finish(): void
  /** Drop the connection without the end-of-stream handshake. */
  close(): void
}
