/* 只读历史 API 的跨域白名单策略：仅向明确允许的前端源返回 CORS 响应头。 */

export function parseAllowedOrigins(raw = '') {
  return new Set(
    String(raw)
      .split(',')
      .map(item => item.trim().replace(/\/$/, ''))
      .filter(Boolean),
  )
}

export function corsHeaders(requestOrigin, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins.size === 0) return {}
  if (requestOrigin && allowedOrigins.has(requestOrigin)) {
    return {
      'Access-Control-Allow-Origin': requestOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    }
  }
  return { Vary: 'Origin' }
}
