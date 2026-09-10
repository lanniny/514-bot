/**
 * Bot transcript DOM helpers.
 * Keep empty-hero and live bubbles from occupying the same stream.
 */

const TRANSCRIPT_ITEM = ".bot-message, .bot-activity-group, .live-delta-bubble, [data-bot-card], .bot-typing";

export function botStreamHasMessages(stream) {
  return Boolean(stream?.querySelector?.(TRANSCRIPT_ITEM));
}

export function botClearEmptyConversation(stream) {
  if (!stream?.querySelectorAll) return false;
  const empties = [...stream.querySelectorAll(".bot-message-empty")];
  if (!empties.length) return false;
  for (const empty of empties) empty.remove();
  return true;
}

export function botNormalizeTranscript(stream) {
  if (!stream) return false;
  if (!botStreamHasMessages(stream)) return false;
  return botClearEmptyConversation(stream);
}
