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
.dsh-speech-action[data-active],
.dsh-speech-toggle[data-active] {
  color: var(--dsw-alias-label-primary);
}
`
