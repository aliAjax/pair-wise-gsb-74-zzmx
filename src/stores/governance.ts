import { computed, ref, toRaw } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
  ReleaseInvalidReason,
  ReleaseStatus,
  RollbackRecord,
} from '@/models/domain'
import {
  commitState,
  createId,
  loadState,
  readPersistedState,
  resetState,
} from '@/services/repository'
import {
  affectedDependenciesForFrozen,
  buildReleaseRevision,
  differencesForFrozenContracts,
  releaseDeprecationStages,
  releaseFrozenContracts,
  releaseIdempotencyKey,
} from '@/services/freeze'
import {
  activeApprovals,
  activeMigrationConfirmations,
  releaseReadiness,
  validateGovernance,
} from '@/services/selectors'

/** 仍可推进/失效的候选状态；已发布、已回滚是终态，不再受修订影响 */
const OPEN_RELEASE_STATUSES: ReleaseStatus[] = ['draft', 'reviewing', 'approved']
/** 事件进入废弃终态后，发布不得再把其状态拉回 */
const DEPRECATED_EVENT_STATUSES = ['deprecated', 'retired']

export type MutationCode = 'not_found' | 'stale' | 'conflict' | 'gate' | 'bad_revision'

export interface MutationResult<T = void> {
  ok: boolean
  value?: T
  conflict: boolean
  /** 区分“新建候选”与“幂等复用既有候选”，用于提示与判断 */
  created?: boolean
  code?: MutationCode
  reason: string
}

export interface ReleaseOutcome {
  created: boolean
  release: ReleaseCandidate
}

class RejectMutation extends Error {
  constructor(
    public code: MutationCode,
    message: string,
  ) {
    super(message)
  }
}

const STORAGE_KEY = 'eventrail-governance-v2'

/** 治理状态全是可序列化数据，用 JSON 深拷贝以兼容 Pinia 的深层响应式 Proxy */
const cloneState = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())

  // 其他窗口写入时，以持久化层权威版本为准同步内存
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return
      const latest = readPersistedState()
      if (latest && latest.stateVersion !== data.value.stateVersion) {
        data.value = latest
        lastSavedAt.value = new Date().toISOString()
      }
    })
  }

  const issues = computed(() => validateGovernance(data.value))

  const addAudit = (
    draft: GovernanceState,
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    draft.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  /**
   * 以检查点包裹一次写入：
   * - 基于提交前快照构建工作副本，业务校验失败时内存恢复到检查点；
   * - commitState 做 CAS，其他窗口抢先写入则本次提交丢弃，内存恢复到权威版本；
   * - 成功后整体替换为带新 stateVersion 的权威状态。
   */
  const transact = <T>(work: (draft: GovernanceState) => T): MutationResult<T> => {
    const checkpoint = cloneState(toRaw(data.value))
    const expectedVersion = checkpoint.stateVersion ?? 1
    const draft = cloneState(checkpoint)
    let value: T
    try {
      value = work(draft)
    } catch (error) {
      data.value = checkpoint
      if (error instanceof RejectMutation) {
        return { ok: false, conflict: false, code: error.code, reason: error.message }
      }
      throw error
    }
    const committed = commitState(expectedVersion, draft)
    if (!committed.ok) {
      data.value = committed.current
      return {
        ok: false,
        conflict: true,
        code: 'conflict',
        reason: '其他窗口已先写入，本次操作基于最新版本恢复，请重试',
      }
    }
    data.value = committed.state
    lastSavedAt.value = new Date().toISOString()
    return { ok: true, conflict: false, value, reason: '' }
  }

  /** 依据失效原因，把范围内评审中候选及其旧审批、迁移确认立即作废 */
  const invalidateReleases = (
    draft: GovernanceState,
    eventIds: string[] | null,
    deprecation: { eventId: string; reason: ReleaseInvalidReason } | null,
  ): void => {
    const now = new Date().toISOString()
    draft.releases.forEach((release) => {
      if (!OPEN_RELEASE_STATUSES.includes(release.status)) return
      let reason: ReleaseInvalidReason | null = null
      if (eventIds && eventIds.some((id) => release.eventIds.includes(id))) {
        reason = 'contract_revised'
      }
      if (deprecation && release.eventIds.includes(deprecation.eventId)) {
        reason = deprecation.reason
      }
      if (!reason || release.stale) return
      release.stale = true
      release.invalidatedAt = now
      release.invalidatedReason = reason
      release.approvals.forEach((approval) => {
        if (approval.invalid) return
        approval.invalid = true
        approval.invalidatedAt = now
        approval.invalidatedReason = reason
      })
      release.migrationConfirmations.forEach((confirmation) => {
        if (confirmation.invalid) return
        confirmation.invalid = true
        confirmation.invalidatedAt = now
        confirmation.invalidatedReason = reason
      })
      // 因旧确认而标记“已迁移”的下游回退为待迁移，除非仍被其他有效候选确认
      release.affectedDependencyIds.forEach((dependencyId) => {
        const dependency = draft.dependencies.find((item) => item.id === dependencyId)
        if (!dependency || dependency.status !== 'migrated') return
        const stillConfirmed = draft.releases.some(
          (other) =>
            other.id !== release.id &&
            OPEN_RELEASE_STATUSES.includes(other.status) &&
            !other.stale &&
            other.migrationConfirmations.some(
              (item) =>
                item.dependencyId === dependencyId &&
                item.status === 'confirmed' &&
                !item.invalid,
            ),
        )
        if (!stillConfirmed) dependency.status = 'migration_required'
      })
    })
  }

  const saveEvent = (event: EventDefinition): MutationResult =>
    transact((draft) => {
      const index = draft.events.findIndex((item) => item.id === event.id)
      const saved = { ...event, updatedAt: new Date().toISOString() }
      if (index >= 0) {
        draft.events[index] = saved
      } else {
        draft.events.unshift(saved)
      }
      invalidateReleases(draft, [event.id], null)
      addAudit(
        draft,
        'event',
        event.id,
        index >= 0 ? '更新事件' : '创建事件',
        `${event.key} 契约已保存`,
      )
    })

  const saveProperty = (eventId: string, property: EventProperty): MutationResult =>
    transact((draft) => {
      const event = draft.events.find((item) => item.id === eventId)
      if (!event) throw new RejectMutation('not_found', '事件不存在')
      const index = event.properties.findIndex((item) => item.id === property.id)
      if (index >= 0) {
        event.properties[index] = property
      } else {
        event.properties.push(property)
      }
      event.updatedAt = new Date().toISOString()
      invalidateReleases(draft, [eventId], null)
      addAudit(
        draft,
        'property',
        property.id,
        index >= 0 ? '更新属性' : '新增属性',
        `${event.key}.${property.name}`,
      )
    })

  const deleteProperty = (eventId: string, propertyId: string): MutationResult =>
    transact((draft) => {
      const event = draft.events.find((item) => item.id === eventId)
      const property = event?.properties.find((item) => item.id === propertyId)
      if (!event || !property) throw new RejectMutation('not_found', '属性不存在')
      property.deletedAt = new Date().toISOString()
      event.updatedAt = new Date().toISOString()
      invalidateReleases(draft, [eventId], null)
      addAudit(
        draft,
        'property',
        property.id,
        '标记删除',
        `${event.key}.${property.name} 进入删除兼容期`,
      )
    })

  const savePlatformRule = (eventId: string, rule: PlatformRule): MutationResult =>
    transact((draft) => {
      const event = draft.events.find((item) => item.id === eventId)
      if (!event) throw new RejectMutation('not_found', '事件不存在')
      const index = event.platformRules.findIndex((item) => item.id === rule.id)
      if (index >= 0) {
        event.platformRules[index] = rule
      } else {
        event.platformRules.push(rule)
      }
      event.updatedAt = new Date().toISOString()
      invalidateReleases(draft, [eventId], null)
      addAudit(
        draft,
        'platform_rule',
        rule.id,
        index >= 0 ? '更新平台规则' : '新增平台规则',
        `${event.key}/${rule.platform}`,
      )
    })

  const buildRelease = (
    draft: GovernanceState,
    version: string,
    title: string,
    eventIds: string[],
    now: string,
  ): ReleaseCandidate => {
    const frozenContracts = releaseFrozenContracts(draft, eventIds, now)
    const differences = differencesForFrozenContracts(draft.baselines, frozenContracts)
    const affected = affectedDependenciesForFrozen(
      frozenContracts,
      draft.dependencies,
      differences,
    )
    return {
      id: createId('rel'),
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds: affected,
      differences,
      migrationConfirmations: affected.map((dependencyId) => ({
        id: createId('mig'),
        dependencyId,
        version,
        status: 'pending',
        reviewer:
          draft.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
      })),
      approvals: [
        { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '' },
      ],
      createdAt: now,
      frozenContracts,
      deprecationStages: releaseDeprecationStages(draft, eventIds),
      revision: buildReleaseRevision(draft, eventIds),
      stale: false,
      idempotencyKey: releaseIdempotencyKey(version, eventIds),
    }
  }

  const createRelease = (
    version: string,
    title: string,
    eventIds: string[],
  ): MutationResult<ReleaseOutcome> =>
    transact((draft) => {
      const key = releaseIdempotencyKey(version, eventIds)
      // 同版本同范围的候选已存在（含失败重试/并发窗口），直接复用，不重复生成确认
      const existing = draft.releases.find(
        (item) => OPEN_RELEASE_STATUSES.includes(item.status) && item.idempotencyKey === key,
      )
      if (existing) return { created: false, release: existing }
      const now = new Date().toISOString()
      const release = buildRelease(draft, version, title, eventIds, now)
      draft.releases.unshift(release)
      draft.currentVersion = version
      addAudit(
        draft,
        'release',
        release.id,
        '创建发布候选',
        `${version} 包含 ${eventIds.length} 个事件，影响 ${release.affectedDependencyIds.length} 个下游依赖`,
      )
      return { created: true, release }
    })

  /** 候选失效后按最新契约修订重算，旧审批/确认保留审计，不重复生成确认 */
  const rebuildRelease = (releaseId: string): MutationResult<ReleaseOutcome> =>
    transact((draft) => {
      const release = draft.releases.find((item) => item.id === releaseId)
      if (!release) throw new RejectMutation('not_found', '发布候选不存在')
      if (!OPEN_RELEASE_STATUSES.includes(release.status)) {
        throw new RejectMutation('gate', '终态候选不可重算')
      }
      // 已是最新修订：重试直接返回，不再生成确认/审批
      if (!release.stale) return { created: false, release }
      // 并发窗口已先重建出同范围的新候选，只接受先到版本
      const rebuilt = draft.releases.find(
        (item) =>
          item.id !== release.id &&
          OPEN_RELEASE_STATUSES.includes(item.status) &&
          !item.stale &&
          item.idempotencyKey === release.idempotencyKey,
      )
      if (rebuilt) return { created: false, release: rebuilt }

      const now = new Date().toISOString()
      const frozenContracts = releaseFrozenContracts(draft, release.eventIds, now)
      const differences = differencesForFrozenContracts(draft.baselines, frozenContracts)
      const affected = affectedDependenciesForFrozen(
        frozenContracts,
        draft.dependencies,
        differences,
      )
      release.frozenContracts = frozenContracts
      release.deprecationStages = releaseDeprecationStages(draft, release.eventIds)
      release.differences = differences
      release.revision = buildReleaseRevision(draft, release.eventIds)

      const activeConfirmations = release.migrationConfirmations.filter((item) => !item.invalid)
      // 仍受影响但缺少生效确认的依赖才补生成，已不在影响清单的生效确认作废保留
      affected.forEach((dependencyId) => {
        if (activeConfirmations.some((item) => item.dependencyId === dependencyId)) return
        release.migrationConfirmations.push({
          id: createId('mig'),
          dependencyId,
          version: release.version,
          status: 'pending',
          reviewer:
            draft.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
          note: '',
        })
      })
      release.migrationConfirmations.forEach((item) => {
        if (item.invalid || affected.includes(item.dependencyId)) return
        item.invalid = true
        item.invalidatedAt = now
        item.invalidatedReason = 'contract_revised'
      })

      if (activeApprovals(release).length === 0) {
        release.approvals.push(
          { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '' },
          { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '' },
          { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '' },
          { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '' },
        )
      }

      release.affectedDependencyIds = affected
      release.stale = false
      release.invalidatedAt = undefined
      release.invalidatedReason = undefined
      addAudit(
        draft,
        'release',
        release.id,
        '按新修订重算候选',
        `${release.version} 已按最新契约冻结，历史审批与确认标记失效`,
      )
      return { created: true, release }
    })

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): MutationResult =>
    transact((draft) => {
      const release = draft.releases.find((item) => item.id === releaseId)
      if (!release) throw new RejectMutation('not_found', '发布候选不存在')
      if (release.stale) {
        throw new RejectMutation('stale', '候选已按旧修订失效，请先重算再确认迁移')
      }
      const confirmation = release.migrationConfirmations.find(
        (item) => item.id === confirmationId,
      )
      if (!confirmation || confirmation.invalid) {
        throw new RejectMutation('stale', '该迁移确认已随旧修订失效')
      }
      // 重试同一确认直接幂等返回，不重复写状态/审计
      if (confirmation.status === 'confirmed') return
      confirmation.status = 'confirmed'
      confirmation.reviewer = reviewer
      confirmation.note = note
      confirmation.confirmedAt = new Date().toISOString()
      const dependency = draft.dependencies.find((item) => item.id === confirmation.dependencyId)
      if (dependency) dependency.status = 'migrated'
      addAudit(draft, 'dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
    })

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
  ): MutationResult =>
    transact((draft) => {
      const release = draft.releases.find((item) => item.id === releaseId)
      if (!release) throw new RejectMutation('not_found', '发布候选不存在')
      if (release.stale) {
        throw new RejectMutation('stale', '候选已按旧修订失效，请先重算再审批')
      }
      const candidates = release.approvals.filter((item) => item.role === role && !item.invalid)
      const approval = candidates[candidates.length - 1]
      if (!approval) throw new RejectMutation('stale', '该审批已随旧修订失效')
      // 重复提交相同结论视为重试，幂等放行不重复落审计
      if (approval.status === status) return
      approval.status = status
      approval.actor = actor
      approval.comment = comment
      approval.createdAt = new Date().toISOString()
      addAudit(
        draft,
        'release',
        releaseId,
        status === 'approved' ? '审批通过' : '审批驳回',
        `${role}：${comment}`,
      )
    })

  const publishRelease = (releaseId: string): MutationResult =>
    transact((draft) => {
      const release = draft.releases.find((item) => item.id === releaseId)
      if (!release) throw new RejectMutation('not_found', '发布候选不存在')
      if (release.stale) {
        throw new RejectMutation('stale', '候选已随契约修订/废弃计划变化失效，请重算后再发布')
      }
      const readiness = releaseReadiness(release, validateGovernance(draft))
      const migrationsReady = activeMigrationConfirmations(release).every(
        (item) => item.status === 'confirmed',
      )
      const approvalsReady = activeApprovals(release).every((item) => item.status === 'approved')
      if (!migrationsReady || !approvalsReady || readiness < 90) {
        throw new RejectMutation('gate', '迁移确认或四角色审批尚未完成，当前不可发布')
      }
      const now = new Date().toISOString()
      release.status = 'published'
      release.publishedAt = now
      release.eventIds.forEach((eventId) => {
        const event = draft.events.find((item) => item.id === eventId)
        const frozen = release.frozenContracts?.find((item) => item.eventId === eventId)
        // 发布基线来自冻结契约，而非可能已被再次修改的实时事件
        if (frozen) {
          draft.baselines.unshift({
            id: createId('base'),
            eventId,
            version: frozen.version,
            properties: cloneState(frozen.properties),
            createdAt: now,
            status: 'published',
          })
        }
        // 状态互斥：已停采/停用的事件不被发布拉回“已发布”
        if (event && !DEPRECATED_EVENT_STATUSES.includes(event.status)) {
          event.status = 'published'
        }
      })
      addAudit(draft, 'release', release.id, '发布契约', `${release.version} 已发布`)
    })

  const saveDeprecation = (plan: DeprecationPlan): MutationResult =>
    transact((draft) => {
      const existing = draft.deprecations.find((item) => item.id === plan.id)
      // 乐观锁：携带的修订号落后于权威版本时拒绝，只接受先到版本
      if (existing && typeof plan.revision === 'number' && existing.revision !== plan.revision) {
        throw new RejectMutation('bad_revision', '废弃计划已被其他窗口推进，请刷新后重试')
      }
      const next: DeprecationPlan = {
        ...cloneState(plan),
        id: existing?.id ?? (plan.id || createId('plan')),
        revision: (existing?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      }
      if (existing) {
        const previousStatus = existing.status
        Object.assign(existing, next)
        // 推进或取消废弃计划，立即作废引用该事件的评审中候选
        if (previousStatus !== next.status) {
          const reason: ReleaseInvalidReason =
            next.status === 'cancelled' ? 'deprecation_cancelled' : 'deprecation_advanced'
          invalidateReleases(draft, null, { eventId: plan.eventId, reason })
        }
      } else {
        draft.deprecations.unshift(next)
      }
      const event = draft.events.find((item) => item.id === plan.eventId)
      if (event && next.status === 'stopped') event.status = 'deprecated'
      if (event && next.status === 'retired') event.status = 'retired'
      addAudit(
        draft,
        'deprecation',
        next.id,
        existing ? '更新废弃计划' : '创建废弃计划',
        `${event?.key ?? plan.eventId}：${next.status}`,
      )
    })

  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): MutationResult =>
    transact((draft) => {
      const release = draft.releases.find((item) => item.id === releaseId)
      if (!release) throw new RejectMutation('not_found', '发布候选不存在')
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
      draft.rollbacks.unshift(record)
      release.status = 'rolled_back'
      addAudit(draft, 'rollback', record.id, '执行回滚', `${release.version}：${reason}`)
    })

  const verifyRollback = (rollbackId: string, evidence: string): MutationResult =>
    transact((draft) => {
      const record = draft.rollbacks.find((item) => item.id === rollbackId)
      if (!record) throw new RejectMutation('not_found', '回滚记录不存在')
      record.status = 'verified'
      record.evidence = evidence
      addAudit(draft, 'rollback', record.id, '验证回滚', evidence)
    })

  const resetDemo = (): void => {
    data.value = resetState()
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
