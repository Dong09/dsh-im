import test from 'node:test';
import { strictEqual } from 'node:assert';
import { redactionTargetOf, isRedactedMatrixEvent } from '../../../src/channels/matrix/matrix-redaction.mjs';

const roomId = '!room:example.org';
const eventId = '$image:example.org';
const scope = { roomId, eventId };
const redaction = (overrides = {}) => ({
  type: 'm.room.redaction', event_id: '$redaction:example.org',
  sender: '@admin:example.org', content: {}, ...overrides,
});
const image = (marker, overrides = {}) => ({
  type: 'm.room.message', event_id: eventId, room_id: roomId,
  sender: '@alice:example.org', content: {},
  unsigned: { redacted_because: marker }, ...overrides,
});

for (const [name, fields] of [
  ['legacy', { redacts: eventId }],
  ['v11', { content: { redacts: eventId } }],
  ['compatibility aliases', { redacts: eventId, content: { redacts: eventId } }],
]) {
  test(`${name} redaction binds its exact target and accepts administrators`, () => {
    const marker = redaction(fields);
    strictEqual(redactionTargetOf(marker, { roomId }), eventId);
    strictEqual(isRedactedMatrixEvent(image(marker), scope), true);
    strictEqual(isRedactedMatrixEvent(image(marker), { roomId, eventId: '$other' }), false);
  });
}

for (const [name, fields] of [
  ['conflicting aliases', { redacts: '$other', content: { redacts: eventId } }],
  ['malformed legacy alias', { redacts: null, content: { redacts: eventId } }],
  ['malformed modern alias', { redacts: eventId, content: { redacts: '' } }],
  ['whitespace target', { redacts: ` ${eventId}` }],
  ['non-event target', { redacts: '!image:example.org' }],
  ['wrong type', { type: 'm.room.message', redacts: eventId }],
  ['encrypted payload', { type: 'm.room.encrypted', redacts: eventId }],
  ['missing event identity', { event_id: undefined, redacts: eventId }],
  ['malformed event identity', { event_id: 'redaction', redacts: eventId }],
  ['array content', { content: [], redacts: eventId }],
  ['null content', { content: null, redacts: eventId }],
  ['malformed sender', { sender: 'admin', redacts: eventId }],
  ['wrong room', { room_id: '!other:example.org', redacts: eventId }],
  ['room alias', { room_id: '#room:example.org', redacts: eventId }],
  ['null room', { room_id: null, redacts: eventId }],
]) {
  test(`ignores ${name} rather than inventing redaction evidence`, () => {
    const marker = redaction(fields);
    strictEqual(redactionTargetOf(marker, { roomId }), null);
    strictEqual(isRedactedMatrixEvent(image(marker), scope), false);
  });
}

test('explicit targets for another event cannot invalidate the enclosing event', () => {
  const marker = redaction({ content: { redacts: '$other' } });
  strictEqual(redactionTargetOf(marker, { roomId }), '$other');
  strictEqual(isRedactedMatrixEvent(image(marker), scope), false);
});

test('target-less server unsigned copy is bound only to its enclosing event', () => {
  // Pre-v11 redaction of a redaction strips its target; this server assertion is
  // still affirmative evidence, unlike an empty message or a target-less sync event.
  const marker = redaction();
  strictEqual(redactionTargetOf(marker, { roomId }), null);
  strictEqual(isRedactedMatrixEvent(image(marker), scope), true);
  strictEqual(isRedactedMatrixEvent(image(marker), { roomId, eventId: '$different' }), false);
});

test('a redacted v11 redaction retains content.redacts', () => {
  const marker = redaction({ content: { redacts: eventId } });
  strictEqual(redactionTargetOf(marker, { roomId }), eventId);
  strictEqual(isRedactedMatrixEvent(image(marker), scope), true);
});

test('enclosing room identity is checked even when the marker omits its room', () => {
  const marker = redaction({ redacts: eventId });
  for (const room_id of ['!other:example.org', '#room:example.org', null, '']) {
    strictEqual(isRedactedMatrixEvent(image(marker, { room_id }), scope), false);
  }
  const syncEvent = image(marker);
  delete syncEvent.room_id;
  strictEqual(isRedactedMatrixEvent(syncEvent, scope), true);
  strictEqual(redactionTargetOf(redaction({ room_id: roomId, redacts: eventId })), eventId);
});

test('scope requires legal exact room and event IDs without trimming or aliases', () => {
  const event = image(redaction({ redacts: eventId }));
  for (const room of [undefined, null, '', '#room:example.org', `${roomId} `]) {
    strictEqual(isRedactedMatrixEvent(event, { roomId: room, eventId }), false);
    if (room !== undefined) strictEqual(redactionTargetOf(event.unsigned.redacted_because, { roomId: room }), null);
  }
  for (const id of [undefined, null, '', 'image', `${eventId} `]) {
    strictEqual(isRedactedMatrixEvent(event, { roomId, eventId: id }), false);
  }
});

for (const [name, event] of [
  ['null lookup', null], ['empty response', {}],
  ['empty message content', image(undefined)],
  ['empty msgtype', image(undefined, { content: { msgtype: '' } })],
  ['sender mismatch alone', image(undefined, { sender: '@other:example.org' })],
  ['body pretending to be a marker', image(undefined, { content: { redacted_because: redaction() } })],
  ['boolean marker', image(true)], ['text marker', image('removed')],
  ['array marker', image([])], ['empty marker', image({})],
  ['wrong enclosing identity', image(redaction(), { event_id: '$wrong' })],
]) {
  test(`${name} is not confirmed redaction`, () => {
    strictEqual(isRedactedMatrixEvent(event, scope), false);
  });
}

test('modern hash event and v12 room identifiers remain supported', () => {
  const room = '!KplB3ESm99I-4PaRdWxDUKr0Sia5nRhRtykpfs1VloM';
  const id = '$Rqnc-F-dvnEYJTyHq_iKxU2bZ1CI92-kuZq3a5lr5Zg';
  const marker = redaction({ room_id: room, content: { redacts: id } });
  strictEqual(redactionTargetOf(marker, { roomId: room }), id);
  strictEqual(isRedactedMatrixEvent(image(marker, { room_id: room, event_id: id }), { roomId: room, eventId: id }), true);
});
