/**
 * 纯函数：配置归一化与上下文规模测量。不依赖 cordis，便于离线单测。
 */

export const DEFAULT_THRESHOLD_TOKENS = 420000
export const DEFAULT_COOLDOWN_MS = 30000

/**
 * 归一化插件配置。
 * @param {unknown} config - 行配置（可能缺失或类型不对）。
 * @returns {{thresholdTokens: number, cooldownMs: number}}
 */
export function readConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const threshold = Number(raw.thresholdTokens)
  const cooldown = Number(raw.cooldownMs)

  return {
    thresholdTokens:
      Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : DEFAULT_THRESHOLD_TOKENS,
    cooldownMs:
      Number.isFinite(cooldown) && cooldown >= 0 ? Math.floor(cooldown) : DEFAULT_COOLDOWN_MS,
  }
}

/**
 * 从一次 assistant/message 的 usage 推出这次请求的上下文规模。
 *
 * DSH 把一次请求的输入拆成两块记账：`inputTokens`（未命中缓存的部分）与
 * `cacheReadTokens`（命中缓存的部分）。两者相加才是这次请求真正带进去的上下文。
 * 只取 `inputTokens` 会把长会话严重低估。
 *
 * @param {unknown} usage - assistant/message 事件上的 usage 字段。
 * @returns {number} 上下文 token 数；无法测量时返回 -1。
 */
export function contextTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return -1
  const input = Number(usage.inputTokens)
  const cache = Number(usage.cacheReadTokens)
  const inputOk = Number.isFinite(input) && input >= 0
  const cacheOk = Number.isFinite(cache) && cache >= 0
  if (!inputOk && !cacheOk) return -1
  return (inputOk ? input : 0) + (cacheOk ? cache : 0)
}
