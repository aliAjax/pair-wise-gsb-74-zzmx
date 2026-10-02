import type { GovernanceState } from '@/models/domain'
import { normalizeState } from '@/services/freeze'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'eventrail-governance-v2'

/** 读取当前已持久化的权威状态（含最新 stateVersion），不触发种子初始化 */
export const readPersistedState = (): GovernanceState | null => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return normalizeState(JSON.parse(raw) as GovernanceState)
  } catch {
    return null
  }
}

export const loadState = (): GovernanceState => {
  const persisted = readPersistedState()
  if (persisted) return persisted
  const seed = normalizeState(createSeedState())
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
  return seed
}

export const saveState = (state: GovernanceState): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

/**
 * 检查点比较并写入（CAS）：
 * 仅当持久化层的 stateVersion 仍等于 expectedVersion 时才接受本次写入，
 * 否则返回其他窗口已抢先提交的权威状态。
 */
export const commitState = (
  expectedVersion: number,
  state: GovernanceState,
): { ok: true; state: GovernanceState } | { ok: false; current: GovernanceState } => {
  const persisted = readPersistedState()
  if (persisted && persisted.stateVersion !== expectedVersion) {
    return { ok: false, current: persisted }
  }
  const next: GovernanceState = {
    ...JSON.parse(JSON.stringify(state)) as GovernanceState,
    stateVersion: (persisted?.stateVersion ?? expectedVersion) + 1,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  return { ok: true, state: next }
}

export const resetState = (): GovernanceState => {
  const seed = normalizeState(createSeedState())
  saveState(seed)
  return seed
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** 深拷贝可序列化数据（含 Vue reactive Proxy），避免 structuredClone 对代理抛错 */
export const cloneData = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T
