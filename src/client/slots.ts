/**
 * The speech entries' injected faces. Both target slots are declared and
 * typed by ui-conversation; this package only contributes the entries, so no
 * SlotMap merge lives here.
 */
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { AnnounceMode } from './announce-store.ts'
import type { MicRecorder, MicView } from './asr-client.ts'
import type { SpeechView } from './controller.ts'

/** Injected business face of one assistant-message speech entry. */
export interface SpeechInjected {
  hooks: {
    /** Live speech state shared by every message control in this Session. */
    speech: HostObservable<SpeechView>
  }
  /** Speak this message, or stop it when it is already speaking. */
  toggle: (messageId: MessageId, text: string) => void
}

/** Full props of one assistant-message speech button. */
export type SpeechActionProps =
  PropsRuntime<'conversation.chat.assistant-actions'>
  & InjectFace<SpeechInjected>
  & PropsLocale<'speech'>

/** Injected business face of the session-header auto-announce toggle. */
export interface AnnounceToggleInjected {
  hooks: {
    /** Live announce preference, persisted browser-locally. */
    announce: HostObservable<AnnounceMode>
  }
  /** Persist the next announce mode. */
  setAnnounce: (mode: AnnounceMode) => void
}

/** Full props of the session-header auto-announce toggle. */
export type AnnounceToggleProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<AnnounceToggleInjected>
  & PropsLocale<'speech'>

/** Injected business face of the composer's voice-input entry. */
export interface MicInjected {
  hooks: {
    /** Live recorder state shared by the mic control. */
    mic: HostObservable<MicView>
  }
  /** The recorder itself; the component owns draft text assembly. */
  recorder: MicRecorder
}

/** Full props of the composer mic button. */
export type MicButtonProps =
  PropsRuntime<'conversation.input.right'>
  & InjectFace<MicInjected>
  & PropsLocale<'speech'>
