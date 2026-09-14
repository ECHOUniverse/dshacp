/**
 * Session preset resolution for the ACP bridge.
 *
 * Mirrors `@deepseek-ai/dsh-agent-presets` `resolveSessionPreset`: the
 * creation header names the preset a session started with, but a blank-session
 * mode switch appends `agent-preset/selected` events — the last one wins.
 *
 * @module dshacp/preset
 */

import type { Session } from '@deepseek-ai/dsh-session'

/**
 * The preset id a session actually runs, newest logged selection winning.
 * @param session - the session whose header and event log to inspect.
 * @returns the preset id, or `undefined` when the deployment composes none.
 */
export function resolveRecordedPreset(session: Session): string | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected') {
      return event.data.agentPreset
    }
  }
  return session.header.agentPreset
}
