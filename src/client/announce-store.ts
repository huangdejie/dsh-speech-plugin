/**
 * Auto-announce preference, browser-local by design: the sound plays on this
 * machine's speakers, so the toggle belongs to this browser. Persisted through
 * the runtime store engine (localStorage, memory in non-browser environments).
 * The Host settings document is deliberately not used: its client-visible
 * namespace list is closed to out-of-tree plugins today (api-proxy answers
 * `settings-not-exposed`), and a host-global toggle would make every device
 * speak at once.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Announce modes accepted by the toggle. */
export type AnnounceMode = 'off' | 'on'

/** The persisted announce state. */
export interface AnnounceState {
  announce: AnnounceMode
}

/** Read/observe/replace face shared by the header toggle and the watcher. */
export interface AnnounceStore {
  /** Current committed mode ('off' before persistence hydrates). */
  getSnapshot(): AnnounceMode
  /** Observe mode replacement. */
  subscribe(listener: () => void): () => void
  /** Persist the next mode. */
  set(mode: AnnounceMode): void
}

/** Versioned persistence key; bump to invalidate a stored shape change. */
const PERSIST_KEY = 'dsh.speech.announce.v1'

/** Create the persisted announce preference store. */
export function createAnnounceStore(): AnnounceStore {
  const store = createSnapshotStore<AnnounceState>(
    { announce: 'off' },
    { persist: { name: PERSIST_KEY } },
  )
  return {
    getSnapshot: () => store.getSnapshot().announce,
    subscribe: listener => store.subscribe(listener),
    set: mode => { store.update(draft => { draft.announce = mode }) },
  }
}
