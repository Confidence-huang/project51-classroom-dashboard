import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { newerTelemetryTimestamp } from './telemetry-time.js'

test('an invalid or future timestamp cannot block later samples', () => {
  const now = Date.parse('2026-11-24T08:00:00Z')
  const previous = now - 1000
  for (const value of [undefined, 'invalid', '2027-11-24T08:00:00Z']) {
    assert.equal(newerTelemetryTimestamp(value, previous, now), null)
  }
  assert.equal(newerTelemetryTimestamp('2026-11-24T08:00:00Z', previous, now), now)
})

test('a repeated or older stored sample cannot refresh the dashboard', () => {
  const now = Date.parse('2026-11-24T08:00:00Z')
  assert.equal(newerTelemetryTimestamp('2026-11-24T08:00:00Z', now, now), null)
  assert.equal(newerTelemetryTimestamp('2026-11-24T07:59:00Z', now, now), null)
})
