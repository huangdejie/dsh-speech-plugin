/** Plugin configuration schema and defaults (cordis.yml row config). */

import z from '@deepseek-ai/schemastery'

/** Speech synthesis engines; 'auto' picks the first cloud engine whose credentials exist. */
export const SPEECH_ENGINES = ['auto', 'system', 'dashscope', 'volcengine'] as const

/** Configurable engine selector. */
export type SpeechEngine = typeof SPEECH_ENGINES[number]

/** Cloud engines (everything except the browser's built-in voices). */
export type CloudEngine = Exclude<SpeechEngine, 'auto' | 'system'>

/** Speech recognition engines; 'auto' picks the first one whose credentials exist, 'off' disables voice input. */
export const ASR_ENGINES = ['auto', 'off', 'dashscope', 'volcengine'] as const

/** Configurable ASR engine selector, independent of the TTS engine. */
export type AsrEngine = typeof ASR_ENGINES[number]

/** Resolved plugin configuration. */
export interface SpeechPluginConfig {
  /** Engine selector; 'auto' resolves at boot from the present credentials. */
  engine: SpeechEngine
  /** ASR engine selector, independent of `engine`; 'auto' resolves from credentials, 'off' disables voice input. */
  asrEngine: AsrEngine
  /** DashScope (Aliyun Bailian) model name. */
  dashscopeModel: string
  /** DashScope (Aliyun Bailian) realtime ASR model name. */
  dashscopeAsrModel: string
  /** DashScope voice name. */
  dashscopeVoice: string
  /** Volcengine (Doubao) voice/speaker name (must match the granted resource). */
  volcengineVoice: string
  /** Volcengine (Doubao) TTS resource id selecting the model version (seed-tts-2.0, ...). */
  volcengineResourceId: string
  /** Volcengine (Doubao) ASR resource id selecting the model version and billing mode. */
  volcengineAsrResourceId: string
  /** Hard cap on synthesized characters per request (cost guard). */
  maxTextLength: number
  /** Cached synthesis responses kept in memory. */
  cacheEntries: number
}

/** Configurable fields; every deployment-varying choice lives here, never in code. */
export const Config: z<SpeechPluginConfig> = z.object({
  engine: z.union([...SPEECH_ENGINES]).default('auto'),
  asrEngine: z.union([...ASR_ENGINES]).default('auto'),
  dashscopeModel: z.string().default('qwen3-tts-flash'),
  dashscopeAsrModel: z.string().default('paraformer-realtime-v2'),
  dashscopeVoice: z.string().default('Cherry'),
  volcengineVoice: z.string().default('zh_female_vv_uranus_bigtts'),
  volcengineResourceId: z.string().default('seed-tts-2.0'),
  volcengineAsrResourceId: z.string().default('volc.seedasr.sauc.duration'),
  maxTextLength: z.natural().default(8000),
  cacheEntries: z.natural().default(64),
})

/**
 * Mirrors the schema defaults for direct mounts without a config; the Loader
 * path applies the schema's own defaults instead. Keep the two in lockstep.
 */
export const DEFAULT_CONFIG: SpeechPluginConfig = {
  engine: 'auto',
  asrEngine: 'auto',
  dashscopeModel: 'qwen3-tts-flash',
  dashscopeAsrModel: 'paraformer-realtime-v2',
  dashscopeVoice: 'Cherry',
  volcengineVoice: 'zh_female_vv_uranus_bigtts',
  volcengineResourceId: 'seed-tts-2.0',
  volcengineAsrResourceId: 'volc.seedasr.sauc.duration',
  maxTextLength: 8000,
  cacheEntries: 64,
}
