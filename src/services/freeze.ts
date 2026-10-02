import type {
  ContractDifference,
  DeprecationPlan,
  DeprecationStage,
  DownstreamDependency,
  EventDefinition,
  EventVersionSnapshot,
  FrozenEventContract,
  GovernanceState,
  ReleaseInvalidReason,
} from '@/models/domain'
import { affectedDependencies, compareEventContract, latestBaseline } from '@/services/selectors'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 候选创建/重算时冻结单事件契约：属性与平台规则不再随后续编辑漂移 */
export const freezeEventContract = (
  event: EventDefinition,
  frozenAt: string,
): FrozenEventContract => ({
  eventId: event.id,
  eventKey: event.key,
  version: event.version,
  status: event.status,
  trigger: event.trigger,
  properties: clone(event.properties),
  platformRules: clone(event.platformRules),
  frozenAt,
})

/** 候选创建/重算时冻结关联废弃计划的当时阶段 */
export const freezeDeprecationStage = (plan: DeprecationPlan): DeprecationStage => ({
  planId: plan.id,
  eventId: plan.eventId,
  status: plan.status,
  reason: plan.reason,
  owner: plan.owner,
  stopCollectAt: plan.stopCollectAt,
  retireAt: plan.retireAt,
  replacementEventId: plan.replacementEventId,
  migrationNote: plan.migrationNote,
  updatedAt: plan.updatedAt,
})

/** 事件当前所处的有效废弃计划（已取消的不再冻结进候选） */
export const activeDeprecationForEvent = (
  state: GovernanceState,
  eventId: string,
): DeprecationPlan | undefined =>
  state.deprecations.find((plan) => plan.eventId === eventId && plan.status !== 'cancelled')

const eventSignature = (event: EventDefinition): string =>
  `evt:${event.id}@${event.version}@${event.updatedAt}`

const planSignature = (plan: DeprecationPlan): string =>
  `dep:${plan.id}@${plan.status}@${plan.revision ?? 1}`

/** 候选范围内事件契约修订与废弃阶段的汇总标识，变化即代表候选已过期 */
export const buildReleaseRevision = (
  state: GovernanceState,
  eventIds: string[],
): string =>
  eventIds
    .map((eventId) => {
      const event = state.events.find((item) => item.id === eventId)
      if (!event) return `evt:${eventId}@missing`
      const plan = activeDeprecationForEvent(state, eventId)
      return plan ? `${eventSignature(event)}|${planSignature(plan)}` : eventSignature(event)
    })
    .sort()
    .join(';')

/** 同版本同事件范围视为同一候选，重试或并发创建只接受先到版本 */
export const releaseIdempotencyKey = (version: string, eventIds: string[]): string =>
  `${version.trim()}::${[...eventIds].sort().join(',')}`

export const releaseFrozenContracts = (
  state: GovernanceState,
  eventIds: string[],
  frozenAt: string,
): FrozenEventContract[] =>
  eventIds
    .map((eventId) => state.events.find((item) => item.id === eventId))
    .filter((event): event is EventDefinition => Boolean(event))
    .map((event) => freezeEventContract(event, frozenAt))

export const releaseDeprecationStages = (
  state: GovernanceState,
  eventIds: string[],
): DeprecationStage[] =>
  eventIds
    .map((eventId) => activeDeprecationForEvent(state, eventId))
    .filter((plan): plan is DeprecationPlan => Boolean(plan))
    .map(freezeDeprecationStage)

export const compareFrozenEventContract = (
  frozen: FrozenEventContract,
  baseline?: EventVersionSnapshot,
): ContractDifference =>
  compareEventContract(
    { id: frozen.eventId, key: frozen.eventKey, properties: frozen.properties } as EventDefinition,
    baseline,
  )

/** 差异比较始终基于冻结契约，而不是实时事件 */
export const differencesForFrozenContracts = (
  baselines: EventVersionSnapshot[],
  frozenContracts: FrozenEventContract[],
): ContractDifference[] =>
  frozenContracts.map((frozen) =>
    compareFrozenEventContract(frozen, latestBaseline(baselines, frozen.eventId)),
  )

/** 受影响下游基于冻结契约中的属性判定 */
export const affectedDependenciesForFrozen = (
  frozenContracts: FrozenEventContract[],
  dependencies: DownstreamDependency[],
  differences: ContractDifference[],
): string[] => {
  const frozenState: GovernanceState = {
    events: frozenContracts.map((frozen) => ({
      id: frozen.eventId,
      key: frozen.eventKey,
      properties: frozen.properties,
    })) as EventDefinition[],
    scenarios: [],
    dependencies,
    baselines: [],
    releases: [],
    deprecations: [],
    rollbacks: [],
    audit: [],
    currentVersion: '',
  }
  return affectedDependencies(frozenState, differences)
}

/** 当前生效的迁移确认/审批由 selectors 统一派生，避免循环依赖 */
export const releaseInvalidReasonLabel = (reason?: ReleaseInvalidReason): string => {
  switch (reason) {
    case 'contract_revised':
      return '事件契约已修订'
    case 'deprecation_advanced':
      return '废弃计划已推进'
    case 'deprecation_cancelled':
      return '废弃计划已取消'
    default:
      return '候选依据已变化'
  }
}

/** 归一化历史数据，补齐冻结与并发所需字段 */
export const normalizeState = (raw: GovernanceState): GovernanceState => {
  const state = clone(raw)
  if (typeof state.stateVersion !== 'number') state.stateVersion = 1
  state.deprecations.forEach((plan) => {
    if (typeof plan.revision !== 'number') plan.revision = 1
  })
  state.releases.forEach((release) => {
    release.stale = Boolean(release.stale)
    release.approvals.forEach((approval) => {
      approval.invalid = Boolean(approval.invalid)
    })
    release.migrationConfirmations.forEach((confirmation) => {
      confirmation.invalid = Boolean(confirmation.invalid)
    })
    if (!release.idempotencyKey) {
      release.idempotencyKey = releaseIdempotencyKey(release.version, release.eventIds)
    }
  })
  return state
}
