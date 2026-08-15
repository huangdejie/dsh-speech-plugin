/**
 * Auto-announce watcher for one Session: observes the conversation snapshot
 * and speaks assistant messages that settle after subscription. History —
 * including pages prepended later — never announces: a max-seq watermark set
 * at subscribe time separates old from new.
 */
import type {
  AssistantBlock, AssistantMessageNode, ConversationSnapshot, SessionFace,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'

/** Plain text of one assistant message (speech input skips every other block kind). */
export function assistantText(blocks: readonly AssistantBlock[]): string {
  return blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('')
}

/** Settled assistant messages carrying a durable message id. */
function settledMessages(snapshot: ConversationSnapshot): readonly AssistantMessageNode[] {
  return snapshot.nodes.filter((node): node is AssistantMessageNode =>
    node.kind === 'assistant' && node.messageId !== undefined)
}

/**
 * Subscribe to one Session and speak newly settled assistant messages.
 * @param session - the Session whose snapshot is observed.
 * @param announceEnabled - reads the committed announce preference at flush time.
 * @param speak - receives each newly settled message's id and plain text.
 * @returns the unsubscriber.
 */
export function watchSessionSpeech(
  session: SessionFace,
  announceEnabled: () => boolean,
  speak: (messageId: MessageId, text: string) => void,
): () => void {
  let watermark = 0
  for (const node of settledMessages(session.getSnapshot())) watermark = Math.max(watermark, node.seq)

  return session.subscribe(() => {
    for (const node of settledMessages(session.getSnapshot())) {
      if (node.seq <= watermark) continue
      watermark = node.seq
      const messageId = node.messageId
      if (messageId !== undefined && announceEnabled()) {
        speak(messageId, assistantText(node.blocks))
      }
    }
  })
}
