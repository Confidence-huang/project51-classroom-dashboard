/* Resolve the read-only API selected by the deployment or a local preview. */
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function publicApiBase(page, configuredUrl) {
  const url = new URL(page)
  const local = loopback.has(url.hostname)
  const pagesDefault = url.hostname === 'confidence-huang.github.io' ? 'https://api.careerpathdesk.com' : ''
  const fallback = parseBase(configuredUrl?.trim() || pagesDefault, local)
  const query = parseBase(url.searchParams.get('api'), local)
  // A shared production link cannot override the deployment's API with a third-party URL.
  if (local && query && loopback.has(query.hostname)) return query.href.replace(/\/$/, '')
  return fallback ? fallback.href.replace(/\/$/, '') : ''
}

function parseBase(raw, local) {
  if (!raw) return null
  let base
  try { base = new URL(raw) } catch { return null }
  if (base.username || base.password || base.search || base.hash) return null
  if (base.protocol === 'https:' || (local && base.protocol === 'http:' && loopback.has(base.hostname))) return base
  return null
}
