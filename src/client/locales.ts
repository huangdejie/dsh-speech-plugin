/** `speech` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.speak': '播报这条回复',
  'action.stop': '停止播报',
  'announce.enable': '开启自动播报',
  'announce.disable': '关闭自动播报',
} satisfies Record<string, string>

/** The speech namespace key union. */
export type SpeechKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The speech controls' copy. */
    speech: SpeechKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'action.speak': 'Speak this reply',
  'action.stop': 'Stop speaking',
  'announce.enable': 'Enable auto-announce',
  'announce.disable': 'Disable auto-announce',
} satisfies Record<SpeechKey, string>
