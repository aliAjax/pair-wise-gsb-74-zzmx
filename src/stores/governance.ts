import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceEnvelope,
  GovernanceState,
  MigrationConfirmation,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import {
  RevisionConflictError,
  commitState,
  createId,
  deterministicId,
  loadEnvelope,
  subscribeEnvelope,
} from '@/services/repository'
import {
  affectedDependencies,
  contractDifferences,
  detectEventDrift,
  freezeDeprecations,
  freezeEvent,
  isReleasePublishable,
  recalcCandidateImpact,
  validateGovernance,
} from '@/services/selectors'

export type ActionResult<T = undefined> =
  | { ok: true; result: T; replayed: boolean }
  | { ok: false; conflict: boolean; message: string }

const REVIEWING: ReleaseCandidate['status'] = 'reviewing'
const APPROVAL_ROLES: ReleaseApproval['role'][] = ['data', 'product', 'client', 'qa']
const APPROVAL_ACTORS: Record<ReleaseApproval['role'], string> = {
  data: '顾清',
  product: '丁禾',
  client: '江驰',
  qa: '余安',
}
const DEPRECATION_STAGE_LABEL: Record<DeprecationPlan['status'], string> = {
  planned: '已计划',
  announced: '已公告',
  stopped: '已停采',
  retired: '已停用',
  cancelled: '已取消',
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const contractSignature = (event: EventDefinition): string =>
  JSON.stringify({
    key: event.key,
    displayName: event.displayName,
    category: event.category,
    description: event.description,
    trigger: event.trigger,
    status: event.status,
    version: event.version,
    owner: event.owner,
    properties: event.properties,
    platformRules: event.platformRules,
  })

export const useGovernanceStore = defineStore('governance', () => {
  const envelope = ref<GovernanceEnvelope>(loadEnvelope())
  const lastSavedAt = ref(new Date().toISOString())
  const data = computed(() => envelope.value.state)
  const revision = computed(() => envelope.value.revision)

  subscribeEnvelope((next, source) => {
    envelope.value = next
    if (source === 'storage') lastSavedAt.value = new Date().toISOString()
  })

  const issues = computed(() => validateGovernance(data.value))

  /**
   * 以当前检查点提交一次写入：
   * - 修订号冲突直接返回 conflict，不覆盖先到版本；
   * - 持久化失败后从存储检查点重读并重试，确定性 ID + 幂等键保证不重复生成确认。
   */
  const runWrite = async <T>(
    mutate: (state: GovernanceState, nextRevision: number) =>
      | { state: GovernanceState; result: T }
      | undefined,
    options: { idempotencyKey?: string; expectedRevision?: number } = {},
  ): Promise<ActionResult<T>> => {
    const expectedRevision = options.expectedRevision ?? envelope.value.revision
    let attempt = 0
    for (;;) {
      try {
        const committed = commitState<T>(expectedRevision, mutate, {
          idempotencyKey: options.idempotencyKey,
        })
        envelope.value = committed.envelope
        lastSavedAt.value = new Date().toISOString()
        return { ok: true, result: committed.result, replayed: committed.replayed }
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          envelope.value = loadEnvelope()
          return {
            ok: false,
            conflict: true,
            message: `另一个窗口已先写入（修订 ${error.actual}），本操作基于修订 ${error.expected}，已为你恢复到最新检查点`,
          }
        }
        attempt += 1
        if (attempt >= 2) {
          envelope.value = loadEnvelope()
          return { ok: false, conflict: false, message: (error as Error).message }
        }
        await sleep(40)
      }
    }
  }

  const pushAudit = (
    state: GovernanceState,
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    state.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  /** 事件契约修订后，使所有在审候选中针对该事件的旧审批与受影响迁移确认立即失效 */
  const invalidateForEvent = (
    state: GovernanceState,
    eventId: string,
    reason: string,
  ): ReleaseCandidate[] => {
    const touched: ReleaseCandidate[] = []
    state.releases.forEach((release) => {
      if (release.status !== REVIEWING || !release.eventIds.includes(eventId)) return
      let changed = false
      release.migrationConfirmations.forEach((confirmation) => {
        if (confirmation.status === 'invalidated') return
        const dependency = state.dependencies.find(
          (item) => item.id === confirmation.dependencyId,
        )
        const referencesEvent =
          dependency?.propertyRefs.some((reference) => reference.eventId === eventId) ||
          dependency?.eventIds.includes(eventId)
        if (!referencesEvent) return
        confirmation.status = 'invalidated'
        confirmation.invalidatedReason = reason
        confirmation.confirmedAt = undefined
        // 旧确认作废后，下游依赖回到待迁移，避免“已迁移”状态与发布门禁打架
        if (dependency && dependency.status === 'migrated') dependency.status = 'migration_required'
        changed = true
      })
      release.approvals.forEach((approval) => {
        if (approval.status === 'invalidated') return
        approval.status = 'invalidated'
        approval.invalidatedReason = reason
        approval.createdAt = undefined
        changed = true
      })
      if (changed) {
        release.rev += 1
        touched.push(release)
      }
    })
    return touched
  }

  /** 废弃计划推进、取消或内容变更后，冻结了该计划的候选立即失效 */
  const invalidateForDeprecation = (
    state: GovernanceState,
    plan: DeprecationPlan,
    reason: string,
  ): ReleaseCandidate[] => {
    const touched: ReleaseCandidate[] = []
    state.releases.forEach((release) => {
      if (release.status !== REVIEWING) return
      const frozen = release.deprecationSnapshots.some((item) => item.planId === plan.id)
      if (!frozen) return
      let changed = false
      release.migrationConfirmations.forEach((confirmation) => {
        if (confirmation.status === 'invalidated') return
        const dependency = state.dependencies.find(
          (item) => item.id === confirmation.dependencyId,
        )
        if (!dependency?.eventIds.includes(plan.eventId)) return
        confirmation.status = 'invalidated'
        confirmation.invalidatedReason = reason
        confirmation.confirmedAt = undefined
        if (dependency.status === 'migrated') dependency.status = 'migration_required'
        changed = true
      })
      release.approvals.forEach((approval) => {
        if (approval.status === 'invalidated') return
        approval.status = 'invalidated'
        approval.invalidatedReason = reason
        approval.createdAt = undefined
        changed = true
      })
      if (changed) {
        release.rev += 1
        touched.push(release)
      }
    })
    return touched
  }

  const saveEvent = async (event: EventDefinition): Promise<ActionResult<ReleaseCandidate[]>> => {
    const before = data.value.events.find((item) => item.id === event.id)
    const isCreate = !before
    const signatureChanged = !before || contractSignature(before) !== contractSignature(event)
    const result = await runWrite<ReleaseCandidate[]>((state) => {
      const index = state.events.findIndex((item) => item.id === event.id)
      const saved: EventDefinition = { ...structuredClone(event), updatedAt: new Date().toISOString() }
      if (index >= 0) state.events[index] = saved
      else state.events.unshift(saved)

      let invalidated: ReleaseCandidate[] = []
      if (!isCreate && signatureChanged) {
        invalidated = invalidateForEvent(
          state,
          event.id,
          `事件 ${event.key} 契约已修订，候选冻结于旧修订，原审批与受影响迁移确认立即失效`,
        )
      }
      pushAudit(
        state,
        'event',
        event.id,
        index >= 0 ? '更新事件' : '创建事件',
        `${event.key} 契约已保存${invalidated.length ? `，${invalidated.length} 个候选确认已失效` : ''}`,
      )
      return { state, result: invalidated }
    })
    return result
  }

  const saveProperty = async (
    eventId: string,
    property: EventProperty,
  ): Promise<ActionResult> => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return { ok: false, conflict: false, message: '事件不存在' }
    const before = event.properties.find((item) => item.id === property.id)
    const changed = !before || JSON.stringify(before) !== JSON.stringify(property)
    return runWrite((state, _nextRevision) => {
      const target = state.events.find((item) => item.id === eventId)
      if (!target) return undefined
      const index = target.properties.findIndex((item) => item.id === property.id)
      const saved = structuredClone(property)
      if (index >= 0) target.properties[index] = saved
      else target.properties.push(saved)
      target.updatedAt = new Date().toISOString()

      let invalidated: ReleaseCandidate[] = []
      if (changed) {
        invalidated = invalidateForEvent(
          state,
          eventId,
          `属性 ${property.name} 已修订，候选冻结于旧修订，受影响迁移确认与原审批立即失效`,
        )
      }
      pushAudit(
        state,
        'property',
        property.id,
        index >= 0 ? '更新属性' : '新增属性',
        `${target.key}.${property.name}${invalidated.length ? `，${invalidated.length} 个候选确认已失效` : ''}`,
      )
      return { state, result: undefined }
    })
  }

  const deleteProperty = async (eventId: string, propertyId: string): Promise<ActionResult> => {
    return runWrite((state, _nextRevision) => {
      const event = state.events.find((item) => item.id === eventId)
      const property = event?.properties.find((item) => item.id === propertyId)
      if (!event || !property || property.deletedAt) return undefined
      property.deletedAt = new Date().toISOString()
      event.updatedAt = new Date().toISOString()
      const invalidated = invalidateForEvent(
        state,
        eventId,
        `属性 ${property.name} 进入删除兼容期，候选冻结于旧修订，受影响迁移确认与原审批立即失效`,
      )
      pushAudit(
        state,
        'property',
        property.id,
        '标记删除',
        `${event.key}.${property.name} 进入删除兼容期${invalidated.length ? `，${invalidated.length} 个候选确认已失效` : ''}`,
      )
      return { state, result: undefined }
    })
  }

  const savePlatformRule = async (
    eventId: string,
    rule: PlatformRule,
  ): Promise<ActionResult> => {
    const event = data.value.events.find((item) => item.id === eventId)
    const before = event?.platformRules.find((item) => item.id === rule.id)
    const changed = !before || JSON.stringify(before) !== JSON.stringify(rule)
    return runWrite((state, _nextRevision) => {
      const target = state.events.find((item) => item.id === eventId)
      if (!target) return undefined
      const index = target.platformRules.findIndex((item) => item.id === rule.id)
      const saved = structuredClone(rule)
      if (index >= 0) target.platformRules[index] = saved
      else target.platformRules.push(saved)
      target.updatedAt = new Date().toISOString()

      let invalidated: ReleaseCandidate[] = []
      if (changed) {
        invalidated = invalidateForEvent(
          state,
          eventId,
          `平台规则 ${rule.platform} 已修订，候选冻结于旧修订，受影响迁移确认与原审批立即失效`,
        )
      }
      pushAudit(
        state,
        'platform_rule',
        rule.id,
        index >= 0 ? '更新平台规则' : '新增平台规则',
        `${target.key}/${rule.platform}${invalidated.length ? `，${invalidated.length} 个候选确认已失效` : ''}`,
      )
      return { state, result: undefined }
    })
  }

  const buildApprovals = (releaseId: string): ReleaseApproval[] =>
    APPROVAL_ROLES.map((role) => ({
      id: deterministicId('appr', releaseId, role),
      role,
      actor: APPROVAL_ACTORS[role],
      status: 'pending',
      comment: '',
    }))

  const createRelease = async (
    version: string,
    title: string,
    eventIds: string[],
  ): Promise<ActionResult<ReleaseCandidate>> => {
    const idempotencyKey = `create-release:${version}:${[...eventIds].sort().join(',')}`
    // 确定性候选、审批与确认 ID：写入失败重试时不会重复生成
    const releaseId = deterministicId('rel', version, ...[...eventIds].sort())
    // 冻结时间戳固定在本次操作：闭包重试必须得到同一份冻结结果
    const frozenAt = new Date().toISOString()
    return runWrite<ReleaseCandidate>((state, nextRevision) => {
      const existing = state.releases.find(
        (item) => item.version === version && item.id === releaseId,
      )
      if (existing) return { state, result: existing }

      const differences = contractDifferences(state, eventIds)
      const affected = affectedDependencies(state, differences)
      const release: ReleaseCandidate = {
        id: releaseId,
        rev: 1,
        // 冻结到本次写入产生的契约修订
        baseRevision: nextRevision,
        version,
        title,
        status: 'reviewing',
        eventIds: [...eventIds],
        affectedDependencyIds: affected,
        differences,
        migrationConfirmations: affected.map((dependencyId) => ({
          id: deterministicId('mig', releaseId, dependencyId),
          dependencyId,
          version,
          status: 'pending',
          reviewer:
            state.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
          note: '',
          epoch: 0,
        })),
        approvals: buildApprovals(releaseId),
        eventSnapshots: eventIds
          .map((eventId) => state.events.find((event) => event.id === eventId))
          .filter((event): event is EventDefinition => Boolean(event))
          .map((event) => freezeEvent(event, frozenAt)),
        deprecationSnapshots: freezeDeprecations(state, eventIds, frozenAt),
        createdAt: frozenAt,
      }
      state.releases.unshift(release)
      state.currentVersion = version
      pushAudit(
        state,
        'release',
        release.id,
        '创建发布候选',
        `${version} 包含 ${eventIds.length} 个事件，影响 ${affected.length} 个下游依赖，已冻结契约修订与废弃阶段`,
      )
      return { state, result: release }
    }, { idempotencyKey })
  }

  const confirmMigration = async (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): Promise<ActionResult<boolean>> => {
    // 幂等键在提交前确定：同一轮确认的重试不重复生效，重算后的新一轮确认可再次提交
    const currentEpoch =
      data.value.releases
        .find((item) => item.id === releaseId)
        ?.migrationConfirmations.find((item) => item.id === confirmationId)?.epoch ?? 0
    return runWrite<boolean>((state, _nextRevision) => {
      const release = state.releases.find((item) => item.id === releaseId)
      const confirmation = release?.migrationConfirmations.find(
        (item) => item.id === confirmationId,
      )
      // 失效确认不得放行，必须先按新修订重算候选
      if (!release || release.status !== REVIEWING || !confirmation) {
        return { state, result: false }
      }
      if (confirmation.status === 'invalidated') return { state, result: false }
      confirmation.status = 'confirmed'
      confirmation.reviewer = reviewer
      confirmation.note = note
      confirmation.confirmedAt = new Date().toISOString()
      confirmation.invalidatedReason = undefined
      const dependency = state.dependencies.find((item) => item.id === confirmation.dependencyId)
      if (dependency) dependency.status = 'migrated'
      pushAudit(state, 'dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
      return { state, result: true }
    }, { idempotencyKey: `confirm-migration:${confirmationId}:${currentEpoch}` })
  }

  const updateApproval = async (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: Exclude<ReleaseApproval['status'], 'invalidated'>,
    actor: string,
    comment: string,
  ): Promise<ActionResult<boolean>> => {
    return runWrite<boolean>((state) => {
      const release = state.releases.find((item) => item.id === releaseId)
      const approval = release?.approvals.find((item) => item.role === role)
      if (!release || release.status !== REVIEWING || !approval) {
        return { state, result: false }
      }
      // 旧审批已随契约/废弃阶段失效，必须重算候选后重新审批
      if (approval.status === 'invalidated') return { state, result: false }
      approval.status = status
      approval.actor = actor
      approval.comment = comment
      approval.createdAt = new Date().toISOString()
      approval.invalidatedReason = undefined
      pushAudit(
        state,
        'release',
        releaseId,
        status === 'approved' ? '审批通过' : '审批驳回',
        `${role}：${comment}`,
      )
      return { state, result: true }
    }, { idempotencyKey: `approval:${releaseId}:${role}:${status}:${comment}` })
  }

  const publishRelease = async (releaseId: string): Promise<ActionResult<boolean>> => {
    return runWrite<boolean>((state) => {
      const release = state.releases.find((item) => item.id === releaseId)
      if (!release || release.status !== REVIEWING) return { state, result: false }
      // 漂移或失效门禁一律拦截：必须先按新修订重算并重走确认/审批
      if (!isReleasePublishable(state, release, validateGovernance(state))) {
        return { state, result: false }
      }
      release.status = 'published'
      release.publishedAt = new Date().toISOString()
      release.eventIds.forEach((eventId) => {
        const event = state.events.find((item) => item.id === eventId)
        if (event) {
          event.status = 'published'
          state.baselines.unshift({
            id: createId('base'),
            eventId,
            version: event.version,
            properties: structuredClone(event.properties),
            createdAt: new Date().toISOString(),
            status: 'published',
          })
        }
      })
      pushAudit(state, 'release', release.id, '发布契约', `${release.version} 已发布`)
      return { state, result: true }
    }, { idempotencyKey: `publish:${releaseId}` })
  }

  /** 候选页按新修订重算：重新冻结契约与废弃阶段，仅保留影响范围未变的确认，失效审批回到待处理 */
  const rebuildRelease = async (releaseId: string): Promise<ActionResult<ReleaseCandidate>> => {
    const rebuiltAt = new Date().toISOString()
    return runWrite<ReleaseCandidate>((state, nextRevision) => {
      const release = state.releases.find((item) => item.id === releaseId)
      if (!release || release.status !== REVIEWING) return undefined
      const { differences, affectedDependencyIds } = recalcCandidateImpact(state, release)

      // 先基于旧冻结找出漂移事件/废弃计划：触碰这些范围的旧确认不得沿用
      const driftedEventIds = new Set(release.eventSnapshots
        .map((snapshot) =>
          detectEventDrift(snapshot, state.events.find((event) => event.id === snapshot.eventId)),
        )
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .map((item) => item.eventId))
      const driftedPlanEventIds = new Set(release.deprecationSnapshots
        .map((snapshot) => {
          const plan = state.deprecations.find((item) => item.id === snapshot.planId)
          return plan && plan.status !== snapshot.status ? plan.eventId : null
        })
        .filter((item): item is string => Boolean(item)))

      const previousById = new Map(
        release.migrationConfirmations.map((item) => [item.dependencyId, item]),
      )
      const migrationConfirmations: MigrationConfirmation[] = affectedDependencyIds.map(
        (dependencyId) => {
          const previous = previousById.get(dependencyId)
          const dependency = state.dependencies.find((item) => item.id === dependencyId)
          const touchesDrift =
            dependency?.eventIds.some(
              (eventId) => driftedEventIds.has(eventId) || driftedPlanEventIds.has(eventId),
            ) ||
            dependency?.propertyRefs.some(
              (reference) => driftedEventIds.has(reference.eventId),
            )
          if (previous?.status === 'confirmed' && !touchesDrift) {
            // 影响范围与冻结基线均未变化，沿用既有确认
            return previous
          }
          return {
            // ID 与创建时保持同一确定性算法：写入失败重试不会重复生成确认
            id: deterministicId('mig', release.id, dependencyId),
            dependencyId,
            version: release.version,
            status: 'pending',
            reviewer: previous?.reviewer || dependency?.owner || '',
            note: previous?.note ?? '',
            // 重算开启新确认轮次：幂等键随轮次变化，旧轮次的重试不会错误命中
            epoch: (previous?.epoch ?? 0) + 1,
          }
        },
      )
      const approvals: ReleaseApproval[] = release.approvals.map((approval) =>
        approval.status === 'invalidated'
          ? { ...approval, status: 'pending', comment: '', invalidatedReason: undefined, createdAt: undefined }
          : approval,
      )

      release.differences = differences
      release.affectedDependencyIds = affectedDependencyIds
      release.migrationConfirmations = migrationConfirmations
      release.approvals = approvals
      release.eventSnapshots = release.eventIds
        .map((eventId) => state.events.find((event) => event.id === eventId))
        .filter((event): event is EventDefinition => Boolean(event))
        .map((event) => freezeEvent(event, rebuiltAt))
      release.deprecationSnapshots = freezeDeprecations(state, release.eventIds, rebuiltAt)
      release.baseRevision = nextRevision
      release.rebuiltAt = rebuiltAt
      release.rev += 1
      pushAudit(
        state,
        'release',
        release.id,
        '按新修订重算候选',
        `已重新冻结 ${release.eventIds.length} 个事件契约与废弃阶段，影响 ${affectedDependencyIds.length} 个下游依赖`,
      )
      return { state, result: release }
    }, { idempotencyKey: `rebuild:${releaseId}` })
  }

  const saveDeprecation = async (plan: DeprecationPlan): Promise<ActionResult<boolean>> => {
    // 以调用方携带的 rev 为乐观锁期望值：它代表本次编辑/推进所基于的计划版本
    const expectedPlanRev = plan.rev
    return runWrite<boolean>((state) => {
      const index = state.deprecations.findIndex((item) => item.id === plan.id)
      if (index >= 0) {
        const current = state.deprecations[index]!
        // 计划级乐观锁：两个窗口同时推进/取消同一计划，只接受先到版本
        if (current.rev !== expectedPlanRev) {
          return { state, result: false }
        }
        const saved: DeprecationPlan = {
          ...structuredClone(plan),
          rev: current.rev + 1,
          updatedAt: new Date().toISOString(),
        }
        state.deprecations[index] = saved
        const event = state.events.find((item) => item.id === saved.eventId)
        if (event && saved.status === 'stopped') event.status = 'deprecated'
        if (event && saved.status === 'retired') event.status = 'retired'
        const reason =
          saved.status === 'cancelled'
            ? `废弃计划已取消，候选冻结的废弃阶段失效，原审批与受影响迁移确认立即失效`
            : current.status !== saved.status
              ? `废弃计划已推进至${DEPRECATION_STAGE_LABEL[saved.status]}，候选冻结于旧阶段，原审批与受影响迁移确认立即失效`
              : `废弃计划内容已修订，候选冻结的废弃阶段失效，原审批与受影响迁移确认立即失效`
        const invalidated = invalidateForDeprecation(state, saved, reason)
        if (event && (saved.status === 'stopped' || saved.status === 'retired')) {
          invalidateForEvent(
            state,
            saved.eventId,
            `事件随废弃计划推进变为${saved.status === 'retired' ? '已停用' : '已废弃'}，冻结契约失效`,
          )
        }
        pushAudit(
          state,
          'deprecation',
          saved.id,
          '更新废弃计划',
          `${event?.key ?? saved.eventId}：${saved.status}${invalidated.length ? `，${invalidated.length} 个候选确认已失效` : ''}`,
        )
      } else {
        const saved: DeprecationPlan = {
          ...structuredClone(plan),
          id: plan.id || createId('plan'),
          rev: 1,
          updatedAt: new Date().toISOString(),
        }
        state.deprecations.unshift(saved)
        pushAudit(
          state,
          'deprecation',
          saved.id,
          '新建废弃计划',
          `${state.events.find((event) => event.id === saved.eventId)?.key ?? saved.eventId}：${saved.status}`,
        )
      }
      return { state, result: true }
    }, { idempotencyKey: `deprecation:${plan.id || plan.eventId}:${plan.status}:${plan.stopCollectAt}` })
  }

  const executeRollback = async (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): Promise<ActionResult> => {
    return runWrite((state, _nextRevision) => {
      const release = state.releases.find((item) => item.id === releaseId)
      if (!release) return undefined
      const record: RollbackRecord = {
        id: createId('rollback'),
        releaseId,
        version: release.version,
        reason,
        operator: '当前用户',
        scope,
        createdAt: new Date().toISOString(),
        status: 'executed',
        evidence,
      }
      state.rollbacks.unshift(record)
      release.status = 'rolled_back'
      pushAudit(state, 'rollback', record.id, '执行回滚', `${release.version}：${reason}`)
      return { state, result: undefined }
    }, { idempotencyKey: `rollback:${releaseId}:${reason}` })
  }

  const verifyRollback = async (rollbackId: string, evidence: string): Promise<ActionResult> => {
    return runWrite((state, _nextRevision) => {
      const record = state.rollbacks.find((item) => item.id === rollbackId)
      if (!record || record.status === 'verified') return undefined
      record.status = 'verified'
      record.evidence = evidence
      pushAudit(state, 'rollback', record.id, '验证回滚', evidence)
      return { state, result: undefined }
    }, { idempotencyKey: `verify-rollback:${rollbackId}` })
  }

  const resetDemo = (): void => {
    // resetState 已写入 revision=1 的全新信封，直接以存储检查点为准
    envelope.value = loadEnvelope()
    lastSavedAt.value = new Date().toISOString()
  }

  const exportContract = (eventIds?: string[]): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        generatedAt: new Date().toISOString(),
        events: selectedEvents.map((event) => ({
          key: event.key,
          displayName: event.displayName,
          version: event.version,
          trigger: event.trigger,
          platforms: event.platformRules.map((rule) => ({
            platform: rule.platform,
            enabled: rule.enabled,
            trigger: rule.trigger,
          })),
          properties: event.properties
            .filter((property) => !property.deletedAt)
            .map(({ name, type, required, enumValues, description }) => ({
              name,
              type,
              required,
              enumValues,
              description,
            })),
        })),
      },
      null,
      2,
    )
  }

  return {
    data,
    envelope,
    revision,
    lastSavedAt,
    issues,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    rebuildRelease,
    confirmMigration,
    updateApproval,
    publishRelease,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
  }
})
