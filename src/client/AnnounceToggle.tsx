/**
 * The session-header auto-announce toggle: flips the durable `ui-speech`
 * announce preference. The speaker stays highlighted while announce is on.
 */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconSpeakerOutline16 } from './icons.tsx'
import type { AnnounceToggleProps } from './slots.ts'

/**
 * The header toggle button.
 * @param props - the injected announce hook, the setter, and the copy.
 * @returns the button in its tooltip.
 */
export function AnnounceToggle({ useAnnounce, setAnnounce, t }: AnnounceToggleProps) {
  const on = useAnnounce(mode => mode) === 'on'
  const label = on ? t('announce.disable') : t('announce.enable')
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className="dsh-speech-toggle"
        aria-label={label}
        aria-pressed={on}
        data-active={on || undefined}
        onClick={() => { setAnnounce(on ? 'off' : 'on') }}
      >
        <IconSpeakerOutline16 />
      </button>
    </Tooltip>
  )
}
