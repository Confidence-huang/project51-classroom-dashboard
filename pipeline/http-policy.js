/* 历史与 AI 助手 API 的跨域白名单策略：仅向明确允许的前端源返回 CORS 响应头。 */

export function parseAllowedOrigins(raw = '') {
  return new Set(
    String(raw)
      .split(',')
      .map(item => item.trim().replace(/\/$/, ''))
      .filter(Boolean),
  )
}

export function isOriginAllowed(requestOrigin, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins.size === 0) return true
  if (!requestOrigin) return true
  return allowedOrigins.has(requestOrigin.replace(/\/$/, ''))
}

export function corsHeaders(requestOrigin, allowedOrigins, allowedMethods = 'GET, OPTIONS') {
  if (!allowedOrigins || allowedOrigins.size === 0) return {}
  const normalized = requestOrigin ? requestOrigin.replace(/\/$/, '') : ''
  if (normalized && allowedOrigins.has(normalized)) {
    return {
      'Access-Control-Allow-Origin': normalized,
      'Access-Control-Allow-Methods': allowedMethods,
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    }
  }
  return { Vary: 'Origin' }
}
