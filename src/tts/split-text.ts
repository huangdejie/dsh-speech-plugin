/**
 * Sentence-aware chunking for cloud TTS input limits. Every provider caps one
 * request (DashScope ~600 chars, Volcengine 1024 UTF-8 bytes ≈ 340 chars), so
 * long messages are split on sentence enders and packed greedily; a sentence
 * longer than the limit is hard-cut.
 */

/** Sentence enders shared by Chinese and Latin text, plus line breaks. */
const SENTENCE_ENDER = /[。！？!?；;\n]/

/**
 * Split one text into speech-sized chunks. The first chunk obeys
 * `firstMaxChars` when smaller than `maxChars`: synthesis latency grows with
 * text length, so a short first chunk starts playback while the rest is still
 * synthesizing (the remaining chunks pack to the full limit).
 * @param text - cleaned plain text to speak.
 * @param maxChars - per-request character limit of the target engine.
 * @param firstMaxChars - character budget for the first chunk only.
 * @returns non-empty chunks, in order, each within its budget.
 */
export function splitForSpeech(
  text: string,
  maxChars: number,
  firstMaxChars: number = maxChars,
): string[] {
  const sentences: string[] = []
  let current = ''
  for (const char of text) {
    current += char
    if (SENTENCE_ENDER.test(char)) {
      sentences.push(current)
      current = ''
    }
  }
  if (current !== '') sentences.push(current)

  const chunks: string[] = []
  let packed = ''
  let limit = firstMaxChars
  const flush = (): void => {
    if (packed !== '') chunks.push(packed)
    packed = ''
    limit = maxChars
  }
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      // Beyond the current budget: hard-cut at the full limit. A first
      // sentence longer than firstMaxChars therefore skips the small-first-
      // chunk optimization — correct, just not optimal for run-on openings.
      flush()
      for (let index = 0; index < sentence.length; index += maxChars) {
        chunks.push(sentence.slice(index, index + maxChars))
      }
      continue
    }
    if (packed.length + sentence.length > limit) flush()
    packed += sentence
  }
  flush()
  return chunks.filter(chunk => chunk.trim() !== '')
}
