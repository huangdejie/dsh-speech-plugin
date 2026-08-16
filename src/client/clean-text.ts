/**
 * Speech text preparation: strips markdown artifacts the model's replies
 * carry, so neither engine reads markup syntax aloud. Code blocks and images
 * are dropped entirely (reading code aloud is noise); everything else keeps
 * its visible text.
 */

/**
 * Normalize one assistant message's text for speech.
 * @param text - raw text blocks of the message.
 * @returns plain spoken-language text; empty when nothing speakable remains.
 */
export function cleanTextForSpeech(text: string): string {
  return text
    // Fenced code blocks first: their bodies must not leak into later rules.
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    // Images (drop) and links (keep the label).
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Inline code keeps its content without the backticks.
    .replace(/`([^`]*)`/g, '$1')
    // Headings, quotes, and list markers keep their text.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    // Emphasis markers and table pipes.
    .replace(/(\*\*|__|\*|~~)/g, '')
    .replace(/\|/g, ' ')
    // Emoji and pictographs (ZWJ sequences, flags, skin-tone modifiers,
    // variation selectors) carry no speech: engines answer them with silence
    // or a long pause mid-playback, so they drop before synthesis.
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{200D}\u{FE0F}]+/gu, ' ')
    // Horizontal rules and stray markup remainders.
    .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
