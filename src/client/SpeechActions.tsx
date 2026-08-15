/**
 * One message's speak control: a speaker button in the assistant action
 * strip. Click speaks the message's text; click again stops. The text is
 * resolved from the conversation snapshot at click time — a read-side lookup,
 * never a per-flush scan.
 */
import { Tooltip, IconStopFill16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { IconSpeakerOutline16 } from './icons.tsx'
import { assistantText } from './speech-watcher.ts'
import type { SpeechActionProps } from './slots.ts'

/**
 * One message's speak/stop button.
 * @param props - the owner's message identity, the injected verbs, the shared
 * speech hook, and the copy.
 * @returns the button in its tooltip.
 */
export function SpeechActions({ messageId, useSpeech, useSession, toggle, t }: SpeechActionProps) {
  const speakingId = useSpeech(view => view.speakingMessageId)
  const nodes = useSession(snapshot => snapshot.nodes)
  const speaking = speakingId === messageId
  const label = speaking ? t('action.stop') : t('action.speak')
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className="dsh-speech-action"
        aria-label={label}
        aria-pressed={speaking}
        data-active={speaking || undefined}
        onClick={() => {
          const node = nodes.find(
            (candidate): candidate is AssistantMessageNode =>
              candidate.kind === 'assistant' && candidate.messageId === messageId,
          )
          toggle(messageId, node === undefined ? '' : assistantText(node.blocks))
        }}
      >
        {speaking ? <IconStopFill16 /> : <IconSpeakerOutline16 />}
      </button>
    </Tooltip>
  )
}
