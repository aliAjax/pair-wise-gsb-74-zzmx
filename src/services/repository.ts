import type { GovernanceEnvelope, GovernanceState } from '@/models/domain'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'eventrail-governance-v2'
const LEGACY_STORAGE_KEY = 'eventrail-governance-v1'
const APPLIED_WRITE_TTL_MS = 24 * 60 * 60 * 1000

/** 写入修订冲突：另一个窗口已经先提交，调用方必须从检查点恢复后刷新 */
export class RevisionConflictError extends Error {
  constructor(
    message: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(message)
    this.name = 'RevisionConflictError'
  }
}

/** 瞬时写入失败：可幂等重试，不会重复生成确认 */
export class WriteFailureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WriteFailureError'
  }
}

type EnvelopeListener = (envelope: GovernanceEnvelope, source: 'storage' | 'write') => void

const listeners = new Set<EnvelopeListener>()

const createEnvelope = (state: GovernanceState, revision = 1): GovernanceEnvelope => ({
  revision,
  state,
  appliedWrites: [],
})

const normalizeEnvelope = (raw: unknown): GovernanceEnvelope | null => {
  if (!raw || typeof raw !== 'object') return null
  const envelope = raw as GovernanceEnvelope
  if (typeof envelope.revision !== 'number' || !envelope.state) return null
  if (!Array.isArray(envelope.appliedWrites)) envelope.appliedWrites = []
  return envelope
}

/** 旧版裸状态迁移到带修订号的信封，并补齐候选/计划冻结字段 */
const migrateLegacy = (raw: string): GovernanceEnvelope => {
  const state = JSON.parse(raw) as GovernanceState
  const migrated = migrateState(state)
  return createEnvelope(migrated, 1)
}

const migrateState = (state: GovernanceState): GovernanceState => ({
  ...state,
  releases: state.releases.map((release) => ({
    ...release,
    rev: release.rev ?? 1,
    baseRevision: release.baseRevision ?? 1,
    eventSnapshots: release.eventSnapshots ?? [],
    deprecationSnapshots: release.deprecationSnapshots ?? [],
    migrationConfirmations: release.migrationConfirmations.map((confirmation) => ({
      ...confirmation,
      epoch: confirmation.epoch ?? 0,
    })),
    approvals: release.approvals.map((approval) => ({
      ...approval,
      status: approval.status === 'invalidated' ? 'invalidated' : approval.status,
    })),
  })),
  deprecations: state.deprecations.map((plan) => ({
    ...plan,
    rev: plan.rev ?? 1,
    updatedAt: plan.updatedAt ?? plan.stopCollectAt ?? new Date().toISOString(),
  })),
})

const readRawEnvelope = (): GovernanceEnvelope => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    const parsed = normalizeEnvelope(JSON.parse(raw) as unknown)
    if (parsed) return parsed
  }
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
  if (legacy) {
    const envelope = migrateLegacy(legacy)
    persistEnvelope(envelope)
    return envelope
  }
  const envelope = createEnvelope(migrateState(createSeedState()), 1)
  persistEnvelope(envelope)
  return envelope
}

const persistEnvelope = (envelope: GovernanceEnvelope): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  } catch (error) {
    throw new WriteFailureError(`状态写入失败：${(error as Error).message}`)
  }
}

const pruneAppliedWrites = (envelope: GovernanceEnvelope): void => {
  const cutoff = Date.now() - APPLIED_WRITE_TTL_MS
  envelope.appliedWrites = envelope.appliedWrites.filter(
    (entry) => new Date(entry.at).getTime() >= cutoff,
  )
}

export const loadEnvelope = (): GovernanceEnvelope => readRawEnvelope()

export const loadState = (): GovernanceState => readRawEnvelope().state

export const saveState = (state: GovernanceState): void => {
  const current = readRawEnvelope()
  const envelope: GovernanceEnvelope = {
    revision: current.revision + 1,
    state,
    appliedWrites: current.appliedWrites,
  }
  pruneAppliedWrites(envelope)
  persistEnvelope(envelope)
  listeners.forEach((listener) => listener(envelope, 'write'))
}

export const resetState = (): GovernanceState => {
  const envelope = createEnvelope(createSeedState(), 1)
  persistEnvelope(envelope)
  listeners.forEach((listener) => listener(envelope, 'write'))
  return envelope.state
}

/**
 * 以乐观锁提交一次业务写入。
 *
 * - expectedRevision 与当前存储修订不一致时抛 RevisionConflictError，且不做任何修改；
 * - idempotencyKey 已成功落库时直接复用既有结果，重试不重复生成迁移确认；
 * - mutate 返回 undefined 表示无实际变更，直接复用当前状态且不推进修订号；
 * - 持久化抛错时本地内存状态已由检查点保证不变，调用方可安全重试。
 */
export const commitState = <T>(
  expectedRevision: number,
  mutate: (
    state: GovernanceState,
    nextRevision: number,
  ) => { state: GovernanceState; result: T } | undefined,
  options: { idempotencyKey?: string } = {},
): { envelope: GovernanceEnvelope; result: T; replayed: boolean } => {
  const before = readRawEnvelope()
  if (before.revision !== expectedRevision) {
    throw new RevisionConflictError(
      `存储修订已变化：当前 ${before.revision}，操作基于 ${expectedRevision}`,
      expectedRevision,
      before.revision,
    )
  }

  const outcome = mutate(before.state, before.revision + 1)
  if (!outcome) {
    return { envelope: before, result: undefined as T, replayed: false }
  }

  const next: GovernanceEnvelope = {
    revision: before.revision + 1,
    state: outcome.state,
    appliedWrites: [...before.appliedWrites],
  }
  pruneAppliedWrites(next)
  if (options.idempotencyKey) {
    if (before.appliedWrites.some((entry) => entry.key === options.idempotencyKey)) {
      return { envelope: before, result: outcome.result, replayed: true }
    }
    next.appliedWrites.push({ key: options.idempotencyKey, at: new Date().toISOString() })
  }
  persistEnvelope(next)
  listeners.forEach((listener) => listener(next, 'write'))
  return { envelope: next, result: outcome.result, replayed: false }
}

/** 幂等写键是否已经成功落库（重试前的快速判定） */
export const hasAppliedWrite = (key: string): boolean =>
  readRawEnvelope().appliedWrites.some((entry) => entry.key === key)

export const subscribeEnvelope = (listener: EnvelopeListener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    const envelope = normalizeEnvelope(JSON.parse(event.newValue) as unknown)
    if (envelope) listeners.forEach((listener) => listener(envelope, 'storage'))
  })
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** 基于业务键的确定性 ID，保证同一次操作的重试不会重复创建迁移确认 */
export const deterministicId = (prefix: string, ...parts: string[]): string => {
  const seed = parts.join('::')
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0
  }
  return `${prefix}-${Math.abs(hash).toString(36)}-${seed.length.toString(36)}`
}
