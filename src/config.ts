/** Plugin configuration schema and defaults (cordis.yml row config). */

import z from '@deepseek-ai/schemastery'

/** Speech synthesis engines; 'auto' picks the first cloud engine whose credentials exist. */
export const SPEECH_ENGINES = ['auto', 'system', 'dashscope', 'volcengine'] as const

/** Configurable engine selector. */
export type SpeechEngine = typeof SPEECH_ENGINES[number]

/** Cloud engines (everything except the browser's built-in voices). */
export type CloudEngine = Exclude<SpeechEngine, 'auto' | 'system'>

/** Resolved plugin configuration. */
export interface SpeechPluginConfig {
  /** Engine selector; 'auto' resolves at boot from the present credentials. */
  engine: SpeechEngine
  /** DashScope (Aliyun Bailian) model name. */
  dashscopeModel: string
  /** DashScope voice name. */
  dashscopeVoice: string
  /** Volcengine (Doubao) application id from the console. */
  volcengineAppId: string
  /** Volcengine voice_type name. */
  volcengineVoice: string
  /** Volcengine model version; empty uses the service default. */
  volcengineModel: string
  /** Hard cap on synthesized characters per request (cost guard). */
  maxTextLength: number
  /** Cached synthesis responses kept in memory. */
  cacheEntries: number
}

/** Configurable fields; every deployment-varying choice lives here, never in code. */
export const Config: z<SpeechPluginConfig> = z.object({
  engine: z.union([...SPEECH_ENGINES]).default('auto'),
  dashscopeModel: z.string().default('qwen3-tts-flash'),
  dashscopeVoice: z.string().default('Cherry'),
  volcengineAppId: z.string().default(''),
  volcengineVoice: z.string().default('zh_male_M392_conversation_wvae_bigtts'),
  volcengineModel: z.string().default(''),
  maxTextLength: z.natural().default(2000),
  cacheEntries: z.natural().default(64),
})

/**
 * Mirrors the schema defaults for direct mounts without a config; the Loader
 * path applies the schema's own defaults instead. Keep the two in lockstep.
 */
export const DEFAULT_CONFIG: SpeechPluginConfig = {
  engine: 'auto',
  dashscopeModel: 'qwen3-tts-flash',
  dashscopeVoice: 'Cherry',
  volcengineAppId: '',
  volcengineVoice: 'zh_male_M392_conversation_wvae_bigtts',
  volcengineModel: '',
  maxTextLength: 2000,
  cacheEntries: 64,
}
