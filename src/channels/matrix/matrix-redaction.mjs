import { isMatrixEventId, isMatrixRoomTargetId, isMatrixUserId } from './matrix-identifiers.mjs';

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function roomMatches(event, roomId) {
  if (roomId !== undefined && !isMatrixRoomTargetId(roomId)) return false;
  return !Object.hasOwn(event, 'room_id')
    || (isMatrixRoomTargetId(event.room_id) && (roomId === undefined || event.room_id === roomId));
}

function redactionEnvelope(event, roomId) {
  return object(event) && event.type === 'm.room.redaction'
    && isMatrixEventId(event.event_id) && object(event.content)
    && (!Object.hasOwn(event, 'sender') || isMatrixUserId(event.sender))
    && roomMatches(event, roomId);
}

// Distinguish absent from invalid: an invalid alias must not be hidden by a
// valid one, or by the enclosing unsigned marker's target binding.
function targetOf(event) {
  const old = Object.hasOwn(event, 'redacts');
  const modern = Object.hasOwn(event.content, 'redacts');
  if ((old && !isMatrixEventId(event.redacts))
    || (modern && !isMatrixEventId(event.content.redacts))
    || (old && modern && event.redacts !== event.content.redacts)) return { valid: false };
  return { valid: true, target: modern ? event.content.redacts : old ? event.redacts : null };
}

/**
 * Extract an explicit target from a trusted homeserver redaction event.
 * `roomId` is the enclosing sync room (room_id may be omitted in sync events).
 * Supplied room IDs must be resolved IDs, not aliases. Returns event ID or null.
 * Does not authenticate arbitrary JSON or independently check room power levels.
 * Supports legacy top-level redacts and v11 content.redacts, requiring agreement.
 * https://spec.matrix.org/v1.16/rooms/v11/#event-format
 */
export function redactionTargetOf(event, { roomId } = {}) {
  if (!redactionEnvelope(event, roomId)) return null;
  const { valid, target } = targetOf(event);
  return valid ? target : null;
}

/**
 * Affirmative read-time evidence for exactly {roomId,eventId}. Input MUST be the
 * event returned by the trusted homeserver, never user content/decrypted content
 * promoted to server unsigned data. Checks enclosing identity before markers.
 *
 * The server's unsigned.redacted_because copy binds to the enclosing event even
 * if its own redacts is absent (older room versions strip it when a redaction
 * is itself redacted). V11 preserves content.redacts; when any target is present
 * it must be legal, consistent and equal to eventId. No room-version inference
 * is made from missing fields. Standalone target-less events cannot invalidate
 * another event. Redactors need not equal the original sender (administrators).
 * https://spec.matrix.org/v1.16/client-server-api/#redactions
 * https://spec.matrix.org/v1.16/rooms/v1/#redactions
 * https://spec.matrix.org/v1.16/rooms/v11/#redactions
 */
export function isRedactedMatrixEvent(event, { roomId, eventId } = {}) {
  if (!isMatrixRoomTargetId(roomId) || !isMatrixEventId(eventId)
    || !object(event) || event.event_id !== eventId || !roomMatches(event, roomId)
    || !object(event.unsigned)) return false;
  const marker = event.unsigned.redacted_because;
  if (!redactionEnvelope(marker, roomId)) return false;
  const { valid, target } = targetOf(marker);
  return valid && (target === null || target === eventId);
}
