/**
 * The composer's voice-input button: click to dictate (live transcript
 * appends into the draft through the composer's public setDraft), click again
 * to finalize. Rendered disabled with its reason while no cloud ASR engine is
 * configured — voice input follows the cloud engines by design.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Tooltip, IconStopFill16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconMicOutline16 } from './icons.tsx'
import type { MicButtonProps } from './slots.ts'

/** One availability probe answer. */
interface Availability {
  readonly available: boolean
  readonly reason: string
}

/**
 * The composer mic control.
 * @param props - the injected mic hook, the draft write path, and the copy.
 * @returns the button in its tooltip.
 */
export function MicButton({ useMic, recorder, inputActions, useInput, t }: MicButtonProps) {
  const status = useMic(view => view.status)
  const micError = useMic(view => view.error)
  const draft = useInput(input => input.draft)
  const phase = useInput(input => input.phase)
  const [unavailable, setUnavailable] = useState<Availability | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  /** Draft content when recording began; the transcript is assembled on top of it. */
  const baseRef = useRef('')
  const committedRef = useRef('')
  const partialRef = useRef('')

  useEffect(() => {
    let alive = true
    void fetch('/dsh-speech/asr/available')
      .then(response => response.json() as Promise<Availability>)
      .then(answer => { if (alive) setUnavailable(answer) })
      .catch(() => { if (alive) setUnavailable({ available: false, reason: 'availability check failed' }) })
    return () => { alive = false }
  }, [])

  // Sending submits the input machine: end dictation right there instead of
  // flushing a late final into the already-sent draft (and burning ASR quota
  // on whatever is said next).
  useEffect(() => {
    if (phase === 'submitting') recorder.cancel()
  }, [phase, recorder])

  const writeDraft = useCallback((): void => {
    const text = `${baseRef.current}${committedRef.current}${partialRef.current}`
    inputActions.setDraft(text)
  }, [inputActions])

  const toggle = useCallback((): void => {
    if (status === 'connecting' || status === 'recording') {
      // Keep the shown text; the flushed final rewrites the tail in place.
      recorder.stop()
      return
    }
    if (status === 'error') return
    baseRef.current = draftRef.current
    committedRef.current = ''
    partialRef.current = ''
    void recorder.start({
      onPartial: text => {
        partialRef.current = text
        writeDraft()
      },
      onFinal: text => {
        committedRef.current += text
        partialRef.current = ''
        writeDraft()
      },
      onDone: () => {
        // Keep whatever text already reached the draft; the user sends it.
      },
    })
  }, [inputActions, recorder, status, writeDraft])

  const disabled = unavailable !== null && !unavailable.available
  const label = status === 'recording' || status === 'connecting'
    ? t('mic.stop')
    : disabled ? t('mic.unavailable') : t('mic.start')
  const tip = disabled ? `${label}（${unavailable?.reason ?? ''}）` : micError !== null ? micError : label

  return (
    <Tooltip label={tip} side="top">
      <button
        type="button"
        className="dsh-speech-mic"
        aria-label={label}
        aria-pressed={status === 'recording'}
        data-recording={status === 'recording' || undefined}
        disabled={disabled || status === 'error'}
        onClick={toggle}
      >
        {status === 'recording' || status === 'connecting' ? <IconStopFill16 /> : <IconMicOutline16 />}
      </button>
    </Tooltip>
  )
}
