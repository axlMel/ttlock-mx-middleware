import { bullJobId } from './bullmqScheduler';

test('traduce ids lógicos a ids distintos y compatibles con BullMQ', () => {
  const ids = ['ack:42:0:1', 'ack:42:0:2', 'api:42:0:1:1', 'api:42:0:1:2'];
  const translated = ids.map(bullJobId);
  expect(new Set(translated).size).toBe(ids.length);
  expect(translated.every((id) => !id.includes(':'))).toBe(true);
});
