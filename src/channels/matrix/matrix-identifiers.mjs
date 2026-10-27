/** Pure identifier guards shared by Matrix protocol and proactive-delivery entrypoints. */

/** Whether a value is a supported fully-qualified Matrix user ID. */
export function isMatrixUserId(value) {
  return typeof value === 'string'
    && /^@[-.=_+/A-Za-z0-9]+:[-.A-Za-z0-9]+(?::\d{1,5})?$/u.test(value);
}

/** Accept v12 hash room IDs and legacy room IDs or aliases used by room lookup/join. */
export function isMatrixRoomId(value) {
  return typeof value === 'string'
    && (/^![A-Za-z0-9_-]{43}$/u.test(value)
      || /^[!#][^:\s]+:[A-Za-z0-9.-]+(?::\d{1,5})?$/u.test(value));
}

/** Delivery routes require resolved room IDs, without the conversation-key thread separator. */
export function isMatrixRoomTargetId(value) {
  return isMatrixRoomId(value) && value.startsWith('!') && !value.includes('$');
}

/** Whether a value is a supported Matrix event ID. */
export function isMatrixEventId(value) {
  return typeof value === 'string' && /^\$[^:\s]+(?::[^\s]+)?$/u.test(value) && value.length <= 512;
}
