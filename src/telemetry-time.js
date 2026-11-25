/* Decide whether a device timestamp can advance the live dashboard's sample. */
export function newerTelemetryTimestamp(capturedAt, previous, now = Date.now()) {
  const time = typeof capturedAt === 'string' ? Date.parse(capturedAt) : NaN
  // Clock skew beyond five seconds must never become the dashboard's high-water mark.
  return Number.isFinite(time) && time > previous && time <= now + 5000 ? time : null
}
