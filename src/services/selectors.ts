import type {
  CandidateDeprecationSnapshot,
  CandidateEventSnapshot,
  ContractDifference,
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  EventVersionSnapshot,
  GovernanceState,
  ReleaseCandidate,
  SampleValidationResult,
  Severity,
  ValidationIssue,
} from '@/models/domain'

const NAMING_PATTERN = /^[a-z][a-z0-9_]{2,31}$/
const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const tokens = (value: string): Set<string> =>
  new Set(normalize(value).split('_').filter((token) => token.length > 1))

const similarity = (left: string, right: string): number => {
  const a = tokens(left)
  const b = tokens(right)
  const union = new Set([...a, ...b])
  const intersection = [...a].filter((token) => b.has(token)).length
  return union.size === 0 ? 0 : intersection / union.size
}

export const latestBaseline = (
  baselines: EventVersionSnapshot[],
  eventId: string,
): EventVersionSnapshot | undefined =>
  baselines
    .filter((baseline) => baseline.eventId === eventId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]

export const compareEventContract = (
  event: EventDefinition,
  baseline?: EventVersionSnapshot,
): ContractDifference => {
  const before = baseline?.properties ?? []
  const after = event.properties.filter((property) => !property.deletedAt)
  const beforeMap = new Map(before.map((property) => [property.id, property]))
  const afterMap = new Map(after.map((property) => [property.id, property]))
  const addedProperties: string[] = []
  const removedProperties: string[] = []
  const requiredChanges: string[] = []
  const typeChanges: string[] = []
  const enumChanges: string[] = []

  after.forEach((property) => {
    const previous = beforeMap.get(property.id)
    if (!previous) {
      addedProperties.push(property.name)
      return
    }
    if (previous.required !== property.required) {
      requiredChanges.push(
        `${property.name}: ${previous.required ? '必填' : '选填'} → ${property.required ? '必填' : '选填'}`,
      )
    }
    if (previous.type !== property.type) {
      typeChanges.push(`${property.name}: ${previous.type} → ${property.type}`)
    }
    if (previous.enumValues.join('|') !== property.enumValues.join('|')) {
      const added = property.enumValues.filter((value) => !previous.enumValues.includes(value))
      const removed = previous.enumValues.filter((value) => !property.enumValues.includes(value))
      enumChanges.push(
        `${property.name}: ${added.length ? `新增 ${added.join('/')}` : ''}${added.length && removed.length ? '；' : ''}${removed.length ? `移除 ${removed.join('/')}` : ''}`,
      )
    }
  })

  before.forEach((property) => {
    if (!afterMap.has(property.id)) removedProperties.push(property.name)
  })

  return {
    eventId: event.id,
    eventKey: event.key,
    addedProperties,
    removedProperties,
    requiredChanges,
    typeChanges,
    enumChanges,
  }
}

export const contractDifferences = (
  state: GovernanceState,
  eventIds: string[],
): ContractDifference[] =>
  eventIds
    .map((eventId) => {
      const event = state.events.find((item) => item.id === eventId)
      if (!event) return null
      return compareEventContract(event, latestBaseline(state.baselines, eventId))
    })
    .filter((item): item is ContractDifference => Boolean(item))

export const affectedDependencies = (
  state: GovernanceState,
  differences: ContractDifference[],
): string[] => {
  const changedPropertyNames = new Set<string>()
  differences.forEach((difference) => {
    ;[
      ...difference.addedProperties,
      ...difference.removedProperties,
      ...difference.requiredChanges.map((item) => item.split(':')[0] ?? ''),
      ...difference.typeChanges.map((item) => item.split(':')[0] ?? ''),
      ...difference.enumChanges.map((item) => item.split(':')[0] ?? ''),
    ].forEach((name) => {
      if (name) changedPropertyNames.add(name)
    })
  })

  return state.dependencies
    .filter((dependency) =>
      dependency.propertyRefs.some((reference) => {
        const event = state.events.find((item) => item.id === reference.eventId)
        const property = event?.properties.find((item) => item.id === reference.propertyId)
        return Boolean(property && changedPropertyNames.has(property.name))
      }),
    )
    .map((dependency) => dependency.id)
}

/** 冻结单事件契约修订：事件、属性与平台规则整体快照 */
export const freezeEvent = (
  event: EventDefinition,
  frozenAt = new Date().toISOString(),
): CandidateEventSnapshot => ({
  eventId: event.id,
  key: event.key,
  displayName: event.displayName,
  category: event.category,
  description: event.description,
  trigger: event.trigger,
  status: event.status,
  version: event.version,
  owner: event.owner,
  properties: structuredClone(event.properties),
  platformRules: structuredClone(event.platformRules),
  frozenAt,
})

export const freezeEvents = (state: GovernanceState, eventIds: string[]): CandidateEventSnapshot[] =>
  eventIds
    .map((eventId) => state.events.find((event) => event.id === eventId))
    .filter((event): event is EventDefinition => Boolean(event))
    .map((event) => freezeEvent(event))

/** 冻结与候选事件相关的废弃计划阶段（事件本身或其替代事件在候选范围内） */
export const freezeDeprecations = (
  state: GovernanceState,
  eventIds: string[],
  frozenAt = new Date().toISOString(),
): CandidateDeprecationSnapshot[] =>
  state.deprecations
    .filter(
      (plan) =>
        plan.status !== 'cancelled' &&
        (eventIds.includes(plan.eventId) ||
          (plan.replacementEventId ? eventIds.includes(plan.replacementEventId) : false)),
    )
    .map((plan) => ({
      planId: plan.id,
      eventId: plan.eventId,
      replacementEventId: plan.replacementEventId,
      status: plan.status,
      stopCollectAt: plan.stopCollectAt,
      retireAt: plan.retireAt,
      migrationNote: plan.migrationNote,
      frozenAt,
    }))

const differencePropertyNames = (difference: ContractDifference): string[] => [
  ...difference.addedProperties,
  ...difference.removedProperties,
  ...difference.requiredChanges.map((item) => item.split(':')[0] ?? ''),
  ...difference.typeChanges.map((item) => item.split(':')[0] ?? ''),
  ...difference.enumChanges.map((item) => item.split(':')[0] ?? ''),
]

export interface CandidateEventDrift {
  eventId: string
  eventKey: string
  changes: string[]
}

export interface CandidateDeprecationDrift {
  planId: string
  eventId: string
  eventKey: string
  changes: string[]
}

export interface ReleaseDrift {
  /** 冻结后事件、属性或平台规则又发生契约修订 */
  eventDrifts: CandidateEventDrift[]
  /** 冻结后废弃计划被推进或取消 */
  deprecationDrifts: CandidateDeprecationDrift[]
  hasDrift: boolean
}

const platformRuleDigest = (snapshot: CandidateEventSnapshot): Map<string, string> => {
  const digest = new Map<string, string>()
  snapshot.platformRules.forEach((rule) => {
    digest.set(
      rule.id,
      JSON.stringify([
        rule.platform,
        rule.enabled,
        rule.trigger,
        rule.owner,
        [...rule.requiredPropertyIds].sort(),
        rule.note,
      ]),
    )
  })
  return digest
}

/** 比较冻结快照与当前事件，列出冻结后发生的契约修订 */
export const detectEventDrift = (
  snapshot: CandidateEventSnapshot,
  event: EventDefinition | undefined,
): CandidateEventDrift | null => {
  const changes: string[] = []
  if (!event) {
    changes.push('事件已从契约库删除')
    return { eventId: snapshot.eventId, eventKey: snapshot.key, changes }
  }

  const scalarFields: Array<{ label: string; before: string; after: string }> = [
    { label: '事件中文名', before: snapshot.displayName, after: event.displayName },
    { label: '业务分类', before: snapshot.category, after: event.category },
    { label: '事件描述', before: snapshot.description, after: event.description },
    { label: '触发时机', before: snapshot.trigger, after: event.trigger },
    { label: '事件状态', before: snapshot.status, after: event.status },
    { label: '事件版本', before: snapshot.version, after: event.version },
    { label: '负责人', before: snapshot.owner, after: event.owner },
  ]
  scalarFields.forEach(({ label, before, after }) => {
    if (before !== after) changes.push(`${label}：${before} → ${after}`)
  })

  const frozenProps = new Map(snapshot.properties.map((property) => [property.id, property]))
  const liveProps = new Map(event.properties.map((property) => [property.id, property]))

  snapshot.properties.forEach((before) => {
    const after = liveProps.get(before.id)
    if (!after) {
      changes.push(`属性 ${before.name} 已删除`)
      return
    }
    if (before.deletedAt !== after.deletedAt) {
      changes.push(`属性 ${after.name} 删除标记发生变化`)
    }
    ;(
      [
        ['name', '属性名'],
        ['type', '类型'],
        ['required', '必填'],
        ['description', '描述'],
        ['owner', '负责人'],
        ['displayName', '中文名'],
      ] as const
    ).forEach(([field, label]) => {
      if (before[field] !== after[field]) {
        changes.push(`属性 ${after.name} ${label}：${String(before[field])} → ${String(after[field])}`)
      }
    })
    if (before.enumValues.join('|') !== after.enumValues.join('|')) {
      changes.push(`属性 ${after.name} 枚举取值发生变化`)
    }
    if (before.synonyms.join('|') !== after.synonyms.join('|')) {
      changes.push(`属性 ${after.name} 同义字段发生变化`)
    }
    if (before.platforms.join('|') !== after.platforms.join('|')) {
      changes.push(`属性 ${after.name} 支持平台发生变化`)
    }
  })
  event.properties.forEach((after) => {
    if (!frozenProps.has(after.id)) changes.push(`新增属性 ${after.name}`)
  })

  const frozenRules = platformRuleDigest(snapshot)
  const liveRules = platformRuleDigest(freezeEvent(event))
  frozenRules.forEach((beforeDigest, ruleId) => {
    const liveDigest = liveRules.get(ruleId)
    if (!liveDigest) {
      const rule = snapshot.platformRules.find((item) => item.id === ruleId)
      changes.push(`平台规则 ${rule?.platform ?? ruleId} 已删除`)
    } else if (liveDigest !== beforeDigest) {
      const rule = event.platformRules.find((item) => item.id === ruleId)
      changes.push(`平台规则 ${rule?.platform ?? ruleId} 已修改`)
    }
  })
  liveRules.forEach((_, ruleId) => {
    if (!frozenRules.has(ruleId)) {
      const rule = event.platformRules.find((item) => item.id === ruleId)
      changes.push(`新增平台规则 ${rule?.platform ?? ruleId}`)
    }
  })

  return changes.length ? { eventId: snapshot.eventId, eventKey: snapshot.key, changes } : null
}

const deprecationStageLabel = (status: DeprecationPlan['status']): string =>
  ({
    planned: '已计划',
    announced: '已公告',
    stopped: '已停采',
    retired: '已停用',
    cancelled: '已取消',
  })[status]

/** 比较冻结的废弃阶段与当前计划 */
export const detectDeprecationDrift = (
  snapshot: CandidateDeprecationSnapshot,
  plan: DeprecationPlan | undefined,
): CandidateDeprecationDrift | null => {
  const changes: string[] = []
  if (!plan) {
    changes.push('废弃计划已删除')
  } else if (plan.status !== snapshot.status) {
    changes.push(`废弃阶段：${deprecationStageLabel(snapshot.status)} → ${deprecationStageLabel(plan.status)}`)
  } else {
    if (plan.stopCollectAt !== snapshot.stopCollectAt) {
      changes.push(`停采日期：${snapshot.stopCollectAt} → ${plan.stopCollectAt}`)
    }
    if (plan.retireAt !== snapshot.retireAt) {
      changes.push(`停用日期：${snapshot.retireAt} → ${plan.retireAt}`)
    }
    if (plan.replacementEventId !== snapshot.replacementEventId) {
      changes.push('替代事件发生变化')
    }
    if (plan.migrationNote !== snapshot.migrationNote) {
      changes.push('迁移说明发生变化')
    }
  }
  if (!changes.length) return null
  return { planId: snapshot.planId, eventId: snapshot.eventId, eventKey: '', changes }
}

/** 候选整体漂移：冻结后契约修订或废弃阶段变化 */
export const detectReleaseDrift = (
  state: GovernanceState,
  release: ReleaseCandidate,
): ReleaseDrift => {
  const eventDrifts = release.eventSnapshots
    .map((snapshot) =>
      detectEventDrift(snapshot, state.events.find((event) => event.id === snapshot.eventId)),
    )
    .filter((item): item is CandidateEventDrift => Boolean(item))

  const deprecationDrifts = release.deprecationSnapshots
    .map((snapshot) => {
      const drift = detectDeprecationDrift(
        snapshot,
        state.deprecations.find((plan) => plan.id === snapshot.planId),
      )
      if (!drift) return null
      const event = state.events.find((item) => item.id === snapshot.eventId)
      return { ...drift, eventKey: event?.key ?? snapshot.eventId }
    })
    .filter((item): item is CandidateDeprecationDrift => Boolean(item))

  return {
    eventDrifts,
    deprecationDrifts,
    hasDrift: eventDrifts.length > 0 || deprecationDrifts.length > 0,
  }
}

/** 以已发布基线重新比较候选事件（与创建候选时同一口径），得到新修订下的完整差异 */
export const compareCandidateAgainstBaseline = (
  state: GovernanceState,
  release: ReleaseCandidate,
): ContractDifference[] => contractDifferences(state, release.eventIds)

/** 重算候选影响范围：以已发布基线重新比较，并覆盖含已删除引用的受影响依赖 */
export const recalcCandidateImpact = (
  state: GovernanceState,
  release: ReleaseCandidate,
): { differences: ContractDifference[]; affectedDependencyIds: string[] } => {
  const differences = compareCandidateAgainstBaseline(state, release)
  const changedNamesByEvent = new Map<string, Set<string>>()
  differences.forEach((difference) => {
    changedNamesByEvent.set(difference.eventId, new Set(differencePropertyNames(difference)))
  })

  // 已删除属性的引用（基线中有、当前契约中没有）也必须进入受影响清单
  state.events.forEach((event) => {
    if (!changedNamesByEvent.has(event.id)) return
    const baseline = latestBaseline(state.baselines, event.id)
    const liveIds = new Set(event.properties.filter((property) => !property.deletedAt).map((p) => p.id))
    const deletedNames = (baseline?.properties ?? [])
      .filter((property) => !liveIds.has(property.id))
      .map((property) => property.name)
    deletedNames.forEach((name) => changedNamesByEvent.get(event.id)!.add(name))
  })

  const affectedDependencyIds = state.dependencies
    .filter((dependency) =>
      dependency.propertyRefs.some((reference) => {
        const changed = changedNamesByEvent.get(reference.eventId)
        if (!changed) return false
        const event = state.events.find((item) => item.id === reference.eventId)
        const property = event?.properties.find((item) => item.id === reference.propertyId)
        // 当前契约中已不存在（被删除）的引用属性同样视为受影响
        return Boolean(!property || changed.has(property.name))
      }),
    )
    .map((dependency) => dependency.id)

  return { differences, affectedDependencyIds }
}

/** 依赖在本次候选中的影响签名；签名相同的历史确认仍可沿用，变化则立即失效 */
export const dependencyImpactSignature = (
  state: GovernanceState,
  release: ReleaseCandidate,
  dependencyId: string,
  differences: ContractDifference[],
): string => {
  const changedNamesByEvent = new Map<string, Set<string>>()
  differences.forEach((difference) => {
    changedNamesByEvent.set(difference.eventId, new Set(differencePropertyNames(difference)))
  })
  const dependency = state.dependencies.find((item) => item.id === dependencyId)
  const refs = (dependency?.propertyRefs ?? [])
    .filter((reference) => changedNamesByEvent.get(reference.eventId)?.size)
    .map((reference) => {
      const changed = changedNamesByEvent.get(reference.eventId)!
      const event = state.events.find((item) => item.id === reference.eventId)
      const property = event?.properties.find((item) => item.id === reference.propertyId)
      return property && changed.has(property.name)
        ? `${reference.eventId}:${property.name}`
        : null
    })
    .filter((item): item is string => Boolean(item))
    .sort()
  const deprecationTie = release.deprecationSnapshots
    .filter(
      (snapshot) =>
        dependency?.eventIds.includes(snapshot.eventId) &&
        state.deprecations.find((plan) => plan.id === snapshot.planId)?.status !== snapshot.status,
    )
    .map((snapshot) => snapshot.planId)
    .sort()
  return JSON.stringify({ refs, deprecationTie })
}

export const validateGovernance = (state: GovernanceState): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const activeEvents = state.events.filter((event) => event.status !== 'retired')

  for (let index = 0; index < activeEvents.length; index += 1) {
    for (let cursor = index + 1; cursor < activeEvents.length; cursor += 1) {
      const left = activeEvents[index]!
      const right = activeEvents[cursor]!
      if (
        left.category === right.category &&
        (similarity(left.key, right.key) >= 0.5 ||
          similarity(left.displayName, right.displayName) >= 0.5)
      ) {
        issues.push({
          id: `duplicate-${left.id}-${right.id}`,
          kind: 'duplicate_event',
          severity: 'high',
          title: `${left.key} 与 ${right.key} 可能重复`,
          detail: `两个事件同属“${left.category}”，名称或语义相似度较高。`,
          entityId: right.id,
          suggestion: '确认是否合并事件，或补充清晰的业务边界说明。',
        })
      }
    }
  }

  activeEvents.forEach((event) => {
    event.properties
      .filter((property) => !property.deletedAt)
      .forEach((property) => {
        if (!NAMING_PATTERN.test(property.name)) {
          issues.push({
            id: `naming-property-${property.id}`,
            kind: 'naming_violation',
            severity: 'medium',
            title: `${event.key}.${property.name} 命名越界`,
            detail: '属性名必须为 3 至 32 位小写 snake_case，并以字母开头。',
            entityId: event.id,
            suggestion: `建议调整为 ${normalize(property.name).slice(0, 32)}。`,
          })
        }
      })
    if (!NAMING_PATTERN.test(event.key)) {
      issues.push({
        id: `naming-event-${event.id}`,
        kind: 'naming_violation',
        severity: 'high',
        title: `${event.key} 事件命名越界`,
        detail: '事件名必须为 3 至 32 位小写 snake_case，并以字母开头。',
        entityId: event.id,
        suggestion: `建议调整为 ${normalize(event.key).slice(0, 32)}。`,
      })
    }
  })

  const properties = activeEvents.flatMap((event) =>
    event.properties.filter((property) => !property.deletedAt).map((property) => ({ event, property })),
  )
  for (let index = 0; index < properties.length; index += 1) {
    for (let cursor = index + 1; cursor < properties.length; cursor += 1) {
      const left = properties[index]!
      const right = properties[cursor]!
      if (
        left.event.id === right.event.id ||
        left.property.name === right.property.name ||
        left.property.type !== right.property.type
      ) {
        continue
      }
      const leftAliases = new Set([left.property.name, ...left.property.synonyms].map(normalize))
      const rightAliases = new Set([right.property.name, ...right.property.synonyms].map(normalize))
      const overlap = [...leftAliases].filter((alias) => rightAliases.has(alias))
      if (overlap.length > 0) {
        issues.push({
          id: `synonym-${left.property.id}-${right.property.id}`,
          kind: 'synonym_property',
          severity: 'medium',
          title: `${left.event.key}.${left.property.name} 与 ${right.event.key}.${right.property.name} 疑似同义`,
          detail: `共享属性别名：${overlap.join('、')}。`,
          entityId: left.event.id,
          suggestion: '统一属性字典，或明确两个字段不可互换的口径差异。',
        })
      }
    }
  }

  activeEvents.forEach((event) => {
    event.properties
      .filter((property) => !property.deletedAt)
      .forEach((property) => {
        const baseline = latestBaseline(state.baselines, event.id)
        const previous = baseline?.properties.find((item) => item.id === property.id)
        if (previous && previous.type !== property.type) {
          issues.push({
            id: `type-${property.id}`,
            kind: 'type_change',
            severity: 'high',
            title: `${event.key}.${property.name} 类型发生变化`,
            detail: `${previous.type} → ${property.type}，下游需要执行迁移兼容。`,
            entityId: event.id,
            suggestion: '确认所有下游依赖已转换为目标类型后再发布。',
          })
        }
      })

    event.platformRules.forEach((rule) => {
      rule.requiredPropertyIds.forEach((propertyId) => {
        const property = event.properties.find((item) => item.id === propertyId)
        if (property && !property.required) {
          issues.push({
            id: `required-${rule.id}-${propertyId}`,
            kind: 'required_mismatch',
            severity: 'medium',
            title: `${event.key} 在 ${rule.platform} 的必填规则不一致`,
            detail: `${rule.platform} 将 ${property.name} 列为必填，但契约属性本身标记为选填。`,
            entityId: event.id,
            suggestion: '统一平台差异说明，或在契约中标记为必填。',
          })
        }
      })
    })
  })

  state.dependencies.forEach((dependency) => {
    dependency.propertyRefs.forEach((reference) => {
      const event = state.events.find((item) => item.id === reference.eventId)
      const property = event?.properties.find((item) => item.id === reference.propertyId)
      if (!property || property.deletedAt) {
        const baseline = latestBaseline(state.baselines, reference.eventId)
        const deletedProperty = baseline?.properties.find((item) => item.id === reference.propertyId)
        issues.push({
          id: `deleted-ref-${dependency.id}-${reference.propertyId}`,
          kind: 'deleted_property_referenced',
          severity: 'critical',
          title: `${dependency.name} 仍引用已删除属性`,
          detail: `${event?.key ?? reference.eventId}.${deletedProperty?.name ?? reference.propertyId} 已不在当前契约中。`,
          entityId: dependency.id,
          suggestion: '要求下游完成迁移确认，或恢复属性并重新评审。',
        })
      }
    })
  })

  return issues.sort((a, b) => {
    const rank: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 }
    return rank[b.severity] - rank[a.severity]
  })
}

export const validateSample = (
  event: EventDefinition,
  payload: Record<string, unknown>,
): SampleValidationResult => {
  const errors: string[] = []
  const warnings: string[] = []
  const activeProperties = event.properties.filter((property) => !property.deletedAt)

  activeProperties.forEach((property) => {
    const value = payload[property.name]
    if (property.required && (value === undefined || value === null || value === '')) {
      errors.push(`缺少必填属性 ${property.name}`)
      return
    }
    if (value === undefined || value === null) return

    const typeMatches = (() => {
      switch (property.type) {
        case 'string':
        case 'enum':
          return typeof value === 'string'
        case 'number':
          return typeof value === 'number'
        case 'boolean':
          return typeof value === 'boolean'
        case 'array':
          return Array.isArray(value)
        case 'object':
          return typeof value === 'object' && !Array.isArray(value)
      }
    })()
    if (!typeMatches) {
      errors.push(`${property.name} 期望 ${property.type}，实际为 ${Array.isArray(value) ? 'array' : typeof value}`)
    }
    if (
      property.type === 'enum' &&
      typeof value === 'string' &&
      !property.enumValues.includes(value)
    ) {
      errors.push(`${property.name} 的值 ${value} 不在枚举 ${property.enumValues.join('/')} 中`)
    }
  })

  Object.keys(payload).forEach((key) => {
    if (!activeProperties.some((property) => property.name === key)) {
      warnings.push(`示例包含未声明属性 ${key}`)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

export const releaseReadiness = (
  release: ReleaseCandidate,
  issues: ValidationIssue[],
): number => {
  // 失效项计入总量但不算完成：失效应直接拉低就绪度，而不是从分母剔除
  const migrationTotal = release.migrationConfirmations.length
  const migrationDone = release.migrationConfirmations.filter(
    (item) => item.status === 'confirmed',
  ).length
  const approvalTotal = release.approvals.length
  const approvalDone = release.approvals.filter((item) => item.status === 'approved').length
  const issuePenalty = Math.min(
    40,
    issues.filter((issue) => release.eventIds.includes(issue.entityId)).length * 8,
  )
  const migrationScore = migrationTotal === 0 ? 40 : (migrationDone / migrationTotal) * 40
  const approvalScore = approvalTotal === 0 ? 30 : (approvalDone / approvalTotal) * 30
  return Math.max(0, Math.round(migrationScore + approvalScore + 30 - issuePenalty))
}

/** 候选是否可放行：失效确认/审批按未完成处理，且冻结后不得存在漂移 */
export const isReleasePublishable = (
  state: GovernanceState,
  release: ReleaseCandidate,
  issues: ValidationIssue[],
): boolean => {
  if (release.status !== 'reviewing') return false
  const drift = detectReleaseDrift(state, release)
  if (drift.hasDrift) return false
  // 必须全量通过：任何 invalidated/pending/rejected 项都阻断放行
  if (!release.migrationConfirmations.every((item) => item.status === 'confirmed')) return false
  if (!release.approvals.every((item) => item.status === 'approved')) return false
  return releaseReadiness(release, issues) >= 90
}

export const propertyReferences = (
  state: GovernanceState,
  propertyId: string,
): Array<{ event: EventDefinition; property: EventProperty }> =>
  state.events.flatMap((event) => {
    const property = event.properties.find((item) => item.id === propertyId)
    return property ? [{ event, property }] : []
  })
