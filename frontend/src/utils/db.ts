/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { Quarantine } from '../types/quarantine';
import type { ReleaseRequest } from '../types/release';
import { rateLevel } from './rate';
import { evaluateRelease, releaseSnapshotText } from './quarantine';
import { nowIso, today, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  /** 苗圃侧：每批苗木的检疫结论与隔离期（独立留底） */
  quarantines!: Table<Quarantine, string>;
  /** 班组侧：按批次报的放行申请（挂起 / 已放行 / 已驳回） */
  releaseRequests!: Table<ReleaseRequest, string>;

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
    this.version(DB_SCHEMA_VERSION)
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
            row.revision = ROW_REVISION;
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

    // ---------- v3：苗圃检疫档案 + 班组放行申请两摊分家 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
        // 检疫档案：按批次一苗一档，plotId 冗余便于按地块直接查档
        quarantines: 'id, seedlingId, plotId, conclusion, version',
        // 放行申请：按批次报，按状态/日期筛选
        releaseRequests: 'id, plotId, seedlingId, state, requestDate',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();
        const seedlingRows = await tx.table<Seedling, string>('seedlings').toArray();

        // 迁移 1：旧数据没有检疫结论 —— 按到场日期给每批补一条「待检」来源；
        // 到场日期补不上（缺失/格式不对）的先搁着，不建档。
        const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
        const quarantineRows: Quarantine[] = [];
        for (const seedling of seedlingRows) {
          if (!validDate(seedling.arrivalDate)) continue;
          quarantineRows.push({
            id: uuid('quarantine'),
            seedlingId: seedling.id,
            plotId: seedling.plotId,
            conclusion: '待检',
            version: 1,
            isolationDays: 0,
            isolatedFrom: seedling.arrivalDate,
            inspectedDate: '',
            inspector: '',
            source: '升级补录',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
        }
        if (quarantineRows.length > 0) await tx.table('quarantines').bulkAdd(quarantineRows);

        // 迁移 2：已栽下去的苗木照旧留着 —— 为既有栽植记录引用到的批次
        // 补一条「已放行」申请（依据第 1 版结论），保证历史栽植总株数不被当成挂起而清零。
        const plantingRows = await tx.table<Planting, string>('plantings').toArray();
        const plantedSeedlingIds = Array.from(new Set(plantingRows.map((row) => row.seedlingId)));
        const quarantineBySeedling = new Map(quarantineRows.map((row) => [row.seedlingId, row]));
        const earliestPlantingBySeedling = new Map<string, string>();
        for (const planting of plantingRows) {
          const current = earliestPlantingBySeedling.get(planting.seedlingId);
          if (current === undefined || planting.plantDate < current) {
            earliestPlantingBySeedling.set(planting.seedlingId, planting.plantDate);
          }
        }
        const releaseRows: ReleaseRequest[] = plantedSeedlingIds.map((seedlingId) => {
          const seedling = seedlingRows.find((row) => row.id === seedlingId);
          const planDate = earliestPlantingBySeedling.get(seedlingId) ?? seedling?.arrivalDate ?? today();
          const quarantine = quarantineBySeedling.get(seedlingId);
          return {
            id: uuid('release'),
            plotId: seedling?.plotId ?? plantingRows.find((row) => row.seedlingId === seedlingId)?.plotId ?? '',
            seedlingId,
            quantity: seedling?.quantity ?? 0,
            operator: '历史栽植班组',
            requestDate: planDate,
            state: '已放行',
            holdReason: '',
            quarantineVersion: quarantine?.version ?? 1,
            releasedConclusion:
              quarantine !== undefined
                ? `${releaseSnapshotText(quarantine)}（旧数据升级补登，${planDate} 前已栽植照旧留底）`
                : `依据第 1 版检疫结论放行（旧数据升级补登，${planDate} 前已栽植照旧留底）`,
            releasedAt: planDate,
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          };
        });
        if (releaseRows.length > 0) await tx.table('releaseRequests').bulkAdd(releaseRows);
      });
  }
}

export const db = new MangroveDatabase();

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

/** 删除地块并级联清理其下苗木批次、检疫档案、放行申请、栽植、验收与补植计划 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.plots,
      db.seedlings,
      db.quarantines,
      db.releaseRequests,
      db.plantings,
      db.surveys,
      db.replants,
    ],
    async () => {
      await db.seedlings.where('plotId').equals(id).delete();
      await db.quarantines.where('plotId').equals(id).delete();
      await db.releaseRequests.where('plotId').equals(id).delete();
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
    db.releaseRequests,
    db.plantings,
    async () => {
      // 该批次已被栽植记录引用时一并清理，避免出现悬空引用；检疫档案与放行申请同批清掉
      await db.plantings.where('seedlingId').equals(id).delete();
      await db.releaseRequests.where('seedlingId').equals(id).delete();
      await db.quarantines.where('seedlingId').equals(id).delete();
      await db.seedlings.delete(id);
    },
  );
}

/* ------------------------------ 苗圃检疫档案 ------------------------------ */

export async function listQuarantines(): Promise<Quarantine[]> {
  return db.quarantines.toArray();
}

export async function listQuarantinesByPlot(plotId: string): Promise<Quarantine[]> {
  return db.quarantines.where('plotId').equals(plotId).toArray();
}

export async function getQuarantineBySeedling(seedlingId: string): Promise<Quarantine | undefined> {
  return db.quarantines.where('seedlingId').equals(seedlingId).first();
}

/**
 * 苗圃侧保存检疫档案。只读写 quarantines 这一张表，不触碰班组的栽植记录：
 * 调用方（nurseryStore）在保存失败时只重试本动作即可。
 */
export async function putQuarantine(row: Quarantine): Promise<void> {
  await db.quarantines.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeQuarantine(id: string): Promise<void> {
  await db.quarantines.delete(id);
}

/**
 * 登记新苗木批次时，苗圃侧自动留一条「待检」底档；已存在档案则不动。
 * 独立于班组数据，失败由调用方自行重试。
 */
export async function ensurePendingQuarantine(seedling: Seedling): Promise<Quarantine | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(seedling.arrivalDate)) return null;
  const existing = await getQuarantineBySeedling(seedling.id);
  if (existing) return existing;
  const stamp = nowIso();
  const row: Quarantine = {
    id: uuid('quarantine'),
    seedlingId: seedling.id,
    plotId: seedling.plotId,
    conclusion: '待检',
    version: 1,
    isolationDays: 0,
    isolatedFrom: seedling.arrivalDate,
    inspectedDate: '',
    inspector: '',
    source: '苗圃登记',
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await db.quarantines.put(row);
  return row;
}

/* ------------------------------ 班组放行申请 ------------------------------ */

export async function listReleaseRequests(): Promise<ReleaseRequest[]> {
  return db.releaseRequests.toArray();
}

export async function listReleaseRequestsByPlot(plotId: string): Promise<ReleaseRequest[]> {
  return db.releaseRequests.where('plotId').equals(plotId).toArray();
}

export async function putReleaseRequest(row: ReleaseRequest): Promise<void> {
  await db.releaseRequests.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReleaseRequest(id: string): Promise<void> {
  await db.releaseRequests.delete(id);
}

/** 取某批次当前处于「已放行」状态的申请（用于判断该批苗能否进入栽植） */
export async function getReleasedRequestBySeedling(seedlingId: string): Promise<ReleaseRequest | undefined> {
  const rows = await db.releaseRequests.where('seedlingId').equals(seedlingId).toArray();
  return rows.find((row) => row.state === '已放行');
}

/**
 * 检疫结论改动后重算所有「还没放行」的申请（挂起 / 已驳回）。
 * 只读写班组自己的放行申请表，绝不改动栽植记录；已放行/已栽植的申请保持原快照不动。
 * 重算后若结论已合格且隔离期满，则按当前结论版本放行并留底；其余维持挂起 / 驳回。
 * 返回被重算的申请条数。
 */
export async function recalcOpenReleaseRequests(
  quarantines?: Quarantine[],
  asOf: string = today(),
): Promise<number> {
  return db.transaction('rw', db.releaseRequests, db.quarantines, async () => {
    const [openRequests, quarantineRows] = await Promise.all([
      db.releaseRequests.where('state').anyOf('挂起', '已驳回').toArray(),
      quarantines ? Promise.resolve(quarantines) : db.quarantines.toArray(),
    ]);
    const bySeedling = new Map(quarantineRows.map((row) => [row.seedlingId, row]));
    const stamp = nowIso();
    const next: ReleaseRequest[] = [];
    for (const request of openRequests) {
      const quarantine = bySeedling.get(request.seedlingId);
      const decision = evaluateRelease(quarantine, asOf);
      const version = quarantine?.version ?? request.quarantineVersion;
      const becomesReleased = decision.state === '已放行';
      if (
        request.state === decision.state &&
        request.holdReason === decision.holdReason &&
        request.quarantineVersion === version
      ) {
        continue;
      }
      next.push({
        ...request,
        state: decision.state,
        holdReason: decision.holdReason,
        quarantineVersion: version,
        // 重算放行时按当前结论版本固化快照，之后苗圃再改也不动已放行/已栽植的
        releasedConclusion: becomesReleased && quarantine ? releaseSnapshotText(quarantine) : '',
        releasedAt: becomesReleased ? asOf : '',
        updatedAt: stamp,
      });
    }
    if (next.length > 0) await db.releaseRequests.bulkPut(next);
    return next.length;
  });
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
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, db.releaseRequests, async () => {
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
    // 挂起批次（没检疫 / 隔离期内）不计栽植总株数，成活率只按已放行批次算
    const releases = await db.releaseRequests.where('plotId').equals(plot.id).toArray();
    const releasedIds = new Set(releases.filter((row) => row.state === '已放行').map((row) => row.seedlingId));
    const total = plantings
      .filter((row) => releasedIds.has(row.seedlingId))
      .reduce((acc, item) => acc + item.count, 0);
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
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
  /** 苗圃侧检疫档案（旧存档可能没有，导入时按空数组兜底） */
  quarantines?: Quarantine[];
  /** 班组侧放行申请（旧存档可能没有，导入时按空数组兜底） */
  releaseRequests?: ReleaseRequest[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, quarantines, releaseRequests] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.quarantines.toArray(),
    db.releaseRequests.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
    quarantines,
    releaseRequests,
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.plots,
      db.seedlings,
      db.plantings,
      db.surveys,
      db.replants,
      db.quarantines,
      db.releaseRequests,
    ],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.quarantines.clear(),
        db.releaseRequests.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
      if (snapshot.quarantines) {
        await db.quarantines.bulkPut(snapshot.quarantines.map((row) => ({ ...row, revision: ROW_REVISION })));
      }
      if (snapshot.releaseRequests) {
        await db.releaseRequests.bulkPut(
          snapshot.releaseRequests.map((row) => ({ ...row, revision: ROW_REVISION })),
        );
      }
    },
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.plots,
      db.seedlings,
      db.plantings,
      db.surveys,
      db.replants,
      db.quarantines,
      db.releaseRequests,
    ],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.quarantines.clear(),
        db.releaseRequests.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, quarantines, releaseRequests] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.quarantines.count(),
    db.releaseRequests.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, quarantines, releaseRequests };
}
