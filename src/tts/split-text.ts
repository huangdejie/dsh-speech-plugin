/**
 * Sentence-aware chunking for cloud TTS input limits. Every provider caps one
 * request (DashScope ~600 chars, Volcengine 1024 UTF-8 bytes ≈ 340 chars), so
 * long messages are split on sentence enders and packed greedily; a sentence
 * longer than the limit is hard-cut.
 */

/** Sentence enders shared by Chinese and Latin text, plus line breaks. */
const SENTENCE_ENDER = /[。！？!?；;\n]/

/**
 * Split one text into speech-sized chunks.
 * @param text - cleaned plain text to speak.
 * @param maxChars - per-request character limit of the target engine.
 * @returns non-empty chunks, in order, each at most `maxChars` characters.
 */
export function splitForSpeech(text: string, maxChars: number): string[] {
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
  const flush = (): void => {
    if (packed !== '') chunks.push(packed)
    packed = ''
  }
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      flush()
      for (let index = 0; index < sentence.length; index += maxChars) {
        chunks.push(sentence.slice(index, index + maxChars))
      }
      continue
    }
    if (packed.length + sentence.length > maxChars) flush()
    packed += sentence
  }
  flush()
  return chunks.filter(chunk => chunk.trim() !== '')
}
