/** Provider contract shared by the cloud TTS engines. */

/** Provider failure carrying whether an identical retry can succeed. */
export class TtsError extends Error {
  /**
   * @param message - provider diagnostic for logs and the route answer.
   * @param retryable - true for transient failures (timeout, 5xx, throttle,
   *   provider-busy); false for deterministic ones (auth, voice, text).
   */
  constructor(message: string, readonly retryable: boolean) {
    super(message)
  }
}

/** One synthesized audio segment, Base64-encoded, plus its media type. */
export interface TtsSegment {
  /** Base64 audio bytes ready for a browser Blob. */
  base64: string
  /** Media type of the encoded bytes (engine-fixed, e.g. audio/mpeg). */
  contentType: string
}

/** Engine-specific settings resolved from plugin config plus environment credentials. */
export interface TtsProviderConfig {
  /** Provider model identifier (may be the empty service default). */
  model: string
  /** Provider voice/speaker identifier. */
  voice: string
}

/** One cloud TTS provider: synthesizes one limited-size text chunk per call. */
export interface TtsProvider {
  /** Stable engine identifier used in responses, cache keys, and diagnostics. */
  readonly engine: string
  /** Engine-specific model/voice identity participating in the cache key. */
  readonly settingsKey: string
  /** Media type every segment of this engine carries. */
  readonly contentType: string
  /** Per-request character limit the splitter must respect. */
  readonly maxChars: number
  /**
   * Synthesize one chunk (already within {@link maxChars}).
   * @param text - chunk to synthesize.
   * @returns the encoded audio segment.
   * @throws Error with the provider's diagnostic on any failure.
   */
  synthesize(text: string): Promise<TtsSegment>
}

/** Successful synthesis answer for one whole message. */
export interface TtsResponse {
  /** Success discriminator shared with the unavailable marker. */
  ok: true
  /** Engine that produced the audio. */
  engine: string
  /** Media type of every part. */
  contentType: string
  /** Base64 audio parts, in playback order. */
  parts: string[]
}
