/**
 * Plugin stylesheet, injected and removed with the plugin fiber. Mirrors the
 * shared message IconActions chrome (28px round icon buttons over the
 * semantic token palette) so the entries sit natively in both strips.
 */
export const SPEECH_CSS = `
.dsh-speech-action,
.dsh-speech-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh-speech-action:hover,
.dsh-speech-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
/* The speaking message keeps the primary label color with a resting bg. */
.dsh-speech-action[data-active] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
/* The announce toggle's on state must read at a glance: success-colored icon
   on a persistent hover-like background, versus plain tertiary when off. */
.dsh-speech-toggle[data-active] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-state-success-primary);
}
.dsh-speech-toggle[data-active]:hover {
  color: var(--dsw-alias-state-success-primary);
}
`
