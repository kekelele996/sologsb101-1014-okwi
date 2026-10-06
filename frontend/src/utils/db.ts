/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 *
 * v3 起把两摊账分开：
 * - 苗圃侧：seedlings（批次进场账）+ quarantines（检疫结论 / 隔离期台账，各自留底）；
 * - 班组侧：releases（按批次报的放行申请）+ plantings（地块栽植 / 成活率依据，各自留底）。
 * 苗圃保存检疫结论只写 quarantines 表、失败只重试自己，绝不把班组栽植记录卷进同一事务。
 *
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { Quarantine, QuarantineDraft } from '../types/quarantine';
import { DEFAULT_ISOLATION_DAYS, isReleasableConclusion } from '../types/quarantine';
import type { ReleaseRequest, ReleaseDraft } from '../types/release';
import { rateLevel } from './rate';
import { evaluateRelease, isolationEndDate, runWithRetry } from './quarantine';
import { nowIso, today, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

/** 到场日期合法格式（升级迁移据此判断「补得上 / 补不上」） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  quarantines!: Table<Quarantine, string>;
  releases!: Table<ReleaseRequest, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = 2;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：苗圃检疫台账与班组放行申请两账分立 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        // 苗圃侧检疫台账：一批一条
        quarantines: 'id, plotId, seedlingId, conclusion, updatedAt',
        // 班组侧放行申请：一批一条申请
        releases: 'id, plotId, seedlingId, state, applyDate, releasedAt',
        // 栽植记录补 releaseId 索引，其余表沿用 v2
        plantings: 'id, plotId, seedlingId, plantDate, spacingM, releaseId',
      })
      .upgrade(async (tx) => {
        // 旧数据没有检疫结论：按到场日期给每批补一条「待检」来源；
        // 到场日期缺失 / 格式不对的批次补不上，先搁着（不建台账，页面提示人工补登）。
        const quarantineTable = tx.table('quarantines');
        const seedlingRows = await tx.table('seedlings').toArray();
        const stamp = nowIso();
        for (const seedling of seedlingRows as Seedling[]) {
          if (typeof seedling.arrivalDate !== 'string' || !DATE_RE.test(seedling.arrivalDate)) continue;
          const existed = await quarantineTable.where('seedlingId').equals(seedling.id).count();
          if (existed > 0) continue;
          const note = `升级迁移：按到场日期 ${seedling.arrivalDate} 补登待检（来源：批次到场日期）`;
          await quarantineTable.add({
            id: quarantineIdOf(seedling.id),
            plotId: seedling.plotId,
            seedlingId: seedling.id,
            conclusion: '待检',
            conclusionDate: '',
            isolationDays: DEFAULT_ISOLATION_DAYS,
            isolationUntil: '',
            note,
            version: 1,
            history: [
              {
                version: 1,
                conclusion: '待检',
                conclusionDate: '',
                isolationDays: DEFAULT_ISOLATION_DAYS,
                note,
                changedAt: stamp,
              },
            ],
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          } satisfies Quarantine);
        }
        // 旧栽植记录是「升级前栽下去的」，照旧保留、不补放行依据：
        // releaseId / basisVersion / basisConclusion 留空，页面标注「升级前栽植」，照常计入总株数。
      });
  }
}

export const db = new MangroveDatabase();

/** 检疫台账主键：与苗木批次一一对应，便于幂等补登 */
export function quarantineIdOf(seedlingId: string): string {
  return `quarantine-${seedlingId}`;
}

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下全部子记录（含苗圃检疫账与班组放行申请） */
export async function removePlot(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.quarantines, db.releases, db.plantings, db.surveys, db.replants],
    async () => {
      await db.seedlings.where('plotId').equals(id).delete();
      await db.quarantines.where('plotId').equals(id).delete();
      await db.releases.where('plotId').equals(id).delete();
      await db.plantings.where('plotId').equals(id).delete();
      await db.surveys.where('plotId').equals(id).delete();
      await db.replants.where('plotId').equals(id).delete();
      await db.plots.delete(id);
    },
  );
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.seedlings,
    db.quarantines,
    db.releases,
    db.plantings,
    async () => {
      // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
      await db.plantings.where('seedlingId').equals(id).delete();
      await db.releases.where('seedlingId').equals(id).delete();
      await db.quarantines.where('seedlingId').equals(id).delete();
      await db.seedlings.delete(id);
    },
  );
}

/* --------------------------- 苗圃检疫台账（苗圃侧留底） --------------------------- */

export async function listQuarantines(): Promise<Quarantine[]> {
  return db.quarantines.toArray();
}

export async function listQuarantinesByPlot(plotId: string): Promise<Quarantine[]> {
  return db.quarantines.where('plotId').equals(plotId).toArray();
}

export async function getQuarantineBySeedling(seedlingId: string): Promise<Quarantine | undefined> {
  return db.quarantines.get(quarantineIdOf(seedlingId));
}

/** 构造一条「待检」台账行（不写库），供新批次登记 / 升级迁移 / 人工补登复用 */
export function buildPendingQuarantine(
  seedling: Pick<Seedling, 'id' | 'plotId' | 'arrivalDate'>,
  source: 'arrival' | 'manual',
): Quarantine {
  const stamp = nowIso();
  const note =
    source === 'arrival'
      ? `批次 ${seedling.arrivalDate || '日期不详'} 进场，按到场日期登记待检（来源：批次到场日期）`
      : '人工补登待检（该批次升级时缺少有效到场日期，暂搁后补）';
  return {
    id: quarantineIdOf(seedling.id),
    plotId: seedling.plotId,
    seedlingId: seedling.id,
    conclusion: '待检',
    conclusionDate: '',
    isolationDays: DEFAULT_ISOLATION_DAYS,
    isolationUntil: '',
    note,
    version: 1,
    history: [
      {
        version: 1,
        conclusion: '待检',
        conclusionDate: '',
        isolationDays: DEFAULT_ISOLATION_DAYS,
        note,
        changedAt: stamp,
      },
    ],
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
}

/**
 * 给批次补登一条待检台账（幂等）。用于：
 * 1）新批次登记时自动挂一本待检账；
 * 2）升级时因到场日期缺失被搁置的批次，由苗圃人工补登。
 */
export async function ensurePendingQuarantine(
  seedling: Pick<Seedling, 'id' | 'plotId' | 'arrivalDate'>,
  source: 'arrival' | 'manual' = 'arrival',
): Promise<Quarantine> {
  const existing = await getQuarantineBySeedling(seedling.id);
  if (existing) return existing;
  const row = buildPendingQuarantine(seedling, source);
  // 苗圃自己的表，失败只重试自己
  await runWithRetry(() => db.quarantines.put(row));
  return row;
}

export interface SaveQuarantineResult {
  row: Quarantine;
  /** 结论 / 日期 / 隔离期是否有改动（改动才 +1 版本） */
  changed: boolean;
  /** 保存后连带重算的挂起申请条数（-1 表示重算失败，但不影响苗圃保存成功） */
  recalcCount: number;
  recalcError: string;
}

/**
 * 苗圃出 / 改检疫结论（苗圃侧留底）。
 *
 * 关键边界：
 * - 只写 quarantines 这一张苗圃自己的表，失败只重试自己；
 * - 班组栽植记录（plantings）不在同一事务里，苗圃重试多少次都不会动班组账；
 * - 结论 / 结论日期 / 隔离期有改动时 version +1，旧版本进 history 留痕；
 * - 保存成功后再单独重算班组侧「还没放行」的申请：挂起批可能因此转可放行；
 *   已放行的申请是终态，不重算，栽下去的照旧并保留 basisVersion 依据。
 */
export async function saveQuarantineConclusion(
  seedlingId: string,
  draft: QuarantineDraft,
): Promise<SaveQuarantineResult> {
  const existing = await getQuarantineBySeedling(seedlingId);
  if (!existing) throw new Error('该批次还没有检疫台账，请先补登待检');

  const stamp = nowIso();
  const changed =
    existing.conclusion !== draft.conclusion ||
    existing.conclusionDate !== draft.conclusionDate ||
    existing.isolationDays !== draft.isolationDays;
  const nextVersion = changed ? existing.version + 1 : existing.version;
  const next: Quarantine = {
    ...existing,
    conclusion: draft.conclusion,
    conclusionDate: draft.conclusionDate,
    isolationDays: draft.isolationDays,
    isolationUntil:
      isReleasableConclusion(draft.conclusion) && draft.conclusionDate !== ''
        ? isolationEndDate(draft.conclusionDate, draft.isolationDays)
        : '',
    note: draft.note.trim(),
    version: nextVersion,
    history: changed
      ? [
          ...existing.history,
          {
            version: nextVersion,
            conclusion: draft.conclusion,
            conclusionDate: draft.conclusionDate,
            isolationDays: draft.isolationDays,
            note: draft.note.trim(),
            changedAt: stamp,
          },
        ]
      : existing.history,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };

  // 只包苗圃自己的写操作；失败由 runWithRetry 只重试这一步
  await runWithRetry(() => db.quarantines.put(next));

  // 苗圃账落库后，再单独重算班组挂起申请（非同一事务，互不回滚）
  let recalcCount = 0;
  let recalcError = '';
  try {
    recalcCount = await refreshHeldReleases();
  } catch (error) {
    recalcError = error instanceof Error ? error.message : '班组挂起申请重算失败';
  }

  return { row: next, changed, recalcCount, recalcError };
}

/* --------------------------- 班组放行申请（班组侧留底） --------------------------- */

export async function listReleases(): Promise<ReleaseRequest[]> {
  const rows = await db.releases.toArray();
  return rows.sort((a, b) => b.applyDate.localeCompare(a.applyDate));
}

export async function listReleasesByPlot(plotId: string): Promise<ReleaseRequest[]> {
  const rows = await db.releases.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.applyDate.localeCompare(a.applyDate));
}

export async function getReleaseBySeedling(seedlingId: string): Promise<ReleaseRequest | undefined> {
  return db.releases.where('seedlingId').equals(seedlingId).first();
}

/** 班组按批次报放行申请；没检疫 / 还在隔离期的自动挂起，等苗圃出结论 */
export async function applyRelease(draft: ReleaseDraft, quarantine: Quarantine | undefined): Promise<ReleaseRequest> {
  const existing = await getReleaseBySeedling(draft.seedlingId);
  if (existing) throw new Error('该批次已报过放行申请，请勿重复申报');

  const stamp = nowIso();
  const day = today();
  const decision = evaluateRelease(quarantine, day);
  const releasable = decision.releasableNow;
  const endDate = quarantine?.isolationUntil ?? '';
  const row: ReleaseRequest = {
    id: uuid('release'),
    plotId: draft.plotId,
    seedlingId: draft.seedlingId,
    requestCount: draft.requestCount,
    applyDate: draft.applyDate,
    operator: draft.operator.trim(),
    state: decision.state,
    reason: decision.reason,
    releasedAt: releasable ? day : '',
    basisVersion: releasable && quarantine ? quarantine.version : null,
    basisConclusion: releasable && quarantine ? quarantine.conclusion : null,
    basisIsolationUntil: releasable ? endDate : null,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await db.releases.put(row);
  return row;
}

/**
 * 重算所有「还没放行」的申请（检疫结论改动后 / 隔离期跨天后调用）。
 * - 已放行是终态：不动（栽下去的照旧，依据快照保留）；
 * - 挂起批满足「合格 + 隔离期满」时转已放行，并写下依据版本；
 * - 其余挂起只刷新状态与说明。
 * 返回状态发生变化的申请条数。
 */
export async function refreshHeldReleases(day: string = today()): Promise<number> {
  const held = await db.releases.filter((row) => row.state !== '已放行').toArray();
  if (held.length === 0) return 0;
  const stamp = nowIso();
  let changedCount = 0;
  for (const request of held) {
    const quarantine = await getQuarantineBySeedling(request.seedlingId);
    const decision = evaluateRelease(quarantine, day);
    if (decision.state === request.state && decision.reason === request.reason) continue;
    const releasable = decision.releasableNow;
    await db.releases.update(request.id, {
      state: decision.state,
      reason: decision.reason,
      releasedAt: releasable ? day : request.releasedAt,
      basisVersion: releasable && quarantine ? quarantine.version : request.basisVersion,
      basisConclusion: releasable && quarantine ? quarantine.conclusion : request.basisConclusion,
      basisIsolationUntil: releasable ? quarantine?.isolationUntil ?? '' : request.basisIsolationUntil,
      updatedAt: stamp,
    });
    changedCount += 1;
  }
  return changedCount;
}

/** 班组撤回放行申请；已产生的栽植记录是班组另一本账，不跟着动 */
export async function removeRelease(id: string): Promise<void> {
  await db.releases.delete(id);
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
 * 挂起批没有放行就没有栽植行，不计进栽植总株数，自然也不会产生补植株数。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (surveys.length === 0) return;
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    // 补植后按「原成活株数 + 本次补植株数」重新计算成活率
    const aliveAfter = latest.aliveCount + replant.missingCount;
    const rate = total > 0 ? Math.round(Math.min(100, (aliveAfter / total) * 100) * 10) / 10 : latest.survivalRate;
    await db.surveys.update(latest.id, {
      aliveCount: aliveAfter,
      survivalRate: rate,
      grade: latest.gradeManual ? latest.grade : rateLevel(rate),
      updatedAt: nowIso(),
    });
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  quarantines: Quarantine[];
  releases: ReleaseRequest[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, quarantines, releases, plantings, surveys, replants] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.quarantines.toArray(),
    db.releases.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    quarantines,
    releases,
    plantings,
    surveys,
    replants,
  };
}

/** 用快照覆盖整库（导入存档）；v3 之前的旧存档没有检疫 / 放行数组，按空集合处理 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.quarantines, db.releases, db.plantings, db.surveys, db.replants],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.quarantines.clear(),
        db.releases.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.quarantines.bulkPut((snapshot.quarantines ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.releases.bulkPut((snapshot.releases ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.quarantines, db.releases, db.plantings, db.surveys, db.replants],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.quarantines.clear(),
        db.releases.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, quarantines, releases, plantings, surveys, replants] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.quarantines.count(),
    db.releases.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
  ]);
  return { plots, seedlings, quarantines, releases, plantings, surveys, replants };
}
