/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：
 * 地块 → 苗木批次 / 苗圃检疫台账 → 班组放行申请 → 栽植 → 验收 → 补植
 * 所有 id 固定，保证 /plots/:id/seedlings、/plots/:id/plantings 深链一定命中真实数据。
 */
import { db, ROW_REVISION } from './db';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Quarantine, QuarantineConclusion, QuarantineHistoryEntry } from '../types/quarantine';
import type { ReleaseRequest } from '../types/release';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant } from '../types/replant';
import { calcSurvivalRate, rateLevel } from './rate';

const SEED_TIME = '2025-01-06T02:00:00.000Z';
const SEED_TIME_PREV = '2025-01-05T02:00:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  plotA: 'plot-donggang-3',
  plotB: 'plot-xiwan-a',
  plotC: 'plot-beiyu-b',
} as const;

function plotRow(row: Omit<Plot, 'createdAt' | 'updatedAt' | 'revision'>): Plot {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function seedlingRow(row: Omit<Seedling, 'createdAt' | 'updatedAt' | 'revision'>): Seedling {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function quarantineRow(
  row: Omit<Quarantine, 'createdAt' | 'updatedAt' | 'revision'>,
): Quarantine {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function releaseRow(row: Omit<ReleaseRequest, 'createdAt' | 'updatedAt' | 'revision'>): ReleaseRequest {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function plantingRow(row: Omit<Planting, 'createdAt' | 'updatedAt' | 'revision'>): Planting {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function surveyRow(row: Omit<Survey, 'createdAt' | 'updatedAt' | 'revision' | 'grade' | 'gradeManual' | 'survivalRate'>, total: number): Survey {
  const survivalRate = calcSurvivalRate(row.aliveCount, total);
  return {
    ...row,
    survivalRate,
    grade: rateLevel(survivalRate),
    gradeManual: false,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  };
}

function replantRow(row: Omit<Replant, 'createdAt' | 'updatedAt' | 'revision'>): Replant {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function historyEntry(
  version: number,
  conclusion: QuarantineConclusion,
  conclusionDate: string,
  isolationDays: number,
  note: string,
  changedAt: string = SEED_TIME,
): QuarantineHistoryEntry {
  return { version, conclusion, conclusionDate, isolationDays, note, changedAt };
}

/**
 * 播种演示数据。调用方（initDatabase）已保证仅在主表为空时调用，因此天然幂等；
 * 这里再做一次防御：若已存在地块则直接返回。
 */
export async function seedDatabase(): Promise<void> {
  const exists = await db.plots.count();
  if (exists > 0) return;

  // ---------------- 地块（3 块，覆盖三种潮位带与三种底质） ----------------
  const plots: Plot[] = [
    plotRow({
      id: SEED_IDS.plotA,
      name: '东港南堤 3 号地块',
      areaMu: 46.5,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      missingCount: 1092,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.plotB,
      name: '西湾滩涂 A 区',
      areaMu: 32,
      tideZone: '低',
      substrate: '砂泥质',
      restoreMode: '补植',
      state: '跟踪中',
      missingCount: 0,
      lastReplantDate: '2025-04-20',
    }),
    plotRow({
      id: SEED_IDS.plotC,
      name: '北屿外滩 B 区',
      areaMu: 58.2,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '已验收',
      missingCount: 560,
      lastReplantDate: '2024-11-08',
    }),
  ];

  // ---------------- 苗木批次（每地块 2 批已下滩 + 东港另有 2 批挂起苗） ----------------
  const seedlings: Seedling[] = [
    seedlingRow({ id: 'seedling-a1', plotId: SEED_IDS.plotA, species: '秋茄', source: '自育苗', spec: '50cm 裸根苗', quantity: 3200, arrivalDate: '2024-04-05' }),
    seedlingRow({ id: 'seedling-a2', plotId: SEED_IDS.plotA, species: '桐花树', source: '外购', spec: '40cm 营养袋苗', quantity: 2400, arrivalDate: '2024-04-10' }),
    seedlingRow({ id: 'seedling-b1', plotId: SEED_IDS.plotB, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 1900, arrivalDate: '2024-04-28' }),
    seedlingRow({ id: 'seedling-b2', plotId: SEED_IDS.plotB, species: '秋茄', source: '外购', spec: '50cm 营养袋苗', quantity: 1600, arrivalDate: '2024-05-02' }),
    seedlingRow({ id: 'seedling-c1', plotId: SEED_IDS.plotC, species: '无瓣海桑', source: '外购', spec: '60cm 营养袋苗', quantity: 4400, arrivalDate: '2024-03-12' }),
    seedlingRow({ id: 'seedling-c2', plotId: SEED_IDS.plotC, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 3900, arrivalDate: '2024-03-16' }),
    // 挂起苗：检疫不合格（不计栽植、不出补植）
    seedlingRow({ id: 'seedling-a3', plotId: SEED_IDS.plotA, species: '秋茄', source: '外购', spec: '50cm 营养袋苗', quantity: 800, arrivalDate: '2024-05-08' }),
    // 挂起苗：结论合格但隔离期未满（演示「挂起-隔离期」，按演示数据固化时点）
    seedlingRow({ id: 'seedling-a4', plotId: SEED_IDS.plotA, species: '桐花树', source: '自育苗', spec: '35cm 营养袋苗', quantity: 600, arrivalDate: '2026-10-02' }),
  ];

  // ---------------- 苗圃检疫台账（每批一条；a2 演示结论改动留两版） ----------------
  const quarantines: Quarantine[] = [
    quarantineRow({
      id: 'quarantine-seedling-a1',
      plotId: SEED_IDS.plotA,
      seedlingId: 'seedling-a1',
      conclusion: '合格',
      conclusionDate: '2024-04-06',
      isolationDays: 6,
      isolationUntil: '2024-04-12',
      note: '现场抽检无病虫害，准予隔离后下滩',
      version: 1,
      history: [historyEntry(1, '合格', '2024-04-06', 6, '现场抽检无病虫害，准予隔离后下滩')],
    }),
    quarantineRow({
      id: 'quarantine-seedling-a2',
      plotId: SEED_IDS.plotA,
      seedlingId: 'seedling-a2',
      conclusion: '复检合格',
      conclusionDate: '2024-04-18',
      isolationDays: 2,
      isolationUntil: '2024-04-20',
      note: '首次结论异常，隔离复检合格',
      version: 2,
      history: [
        historyEntry(1, '合格', '2024-04-11', 4, '初检合格，隔离观察', SEED_TIME_PREV),
        historyEntry(2, '复检合格', '2024-04-18', 2, '首次结论异常，隔离复检合格'),
      ],
    }),
    quarantineRow({
      id: 'quarantine-seedling-b1',
      plotId: SEED_IDS.plotB,
      seedlingId: 'seedling-b1',
      conclusion: '合格',
      conclusionDate: '2024-04-29',
      isolationDays: 6,
      isolationUntil: '2024-05-05',
      note: '',
      version: 1,
      history: [historyEntry(1, '合格', '2024-04-29', 6, '')],
    }),
    quarantineRow({
      id: 'quarantine-seedling-b2',
      plotId: SEED_IDS.plotB,
      seedlingId: 'seedling-b2',
      conclusion: '合格',
      conclusionDate: '2024-05-03',
      isolationDays: 5,
      isolationUntil: '2024-05-08',
      note: '',
      version: 1,
      history: [historyEntry(1, '合格', '2024-05-03', 5, '')],
    }),
    quarantineRow({
      id: 'quarantine-seedling-c1',
      plotId: SEED_IDS.plotC,
      seedlingId: 'seedling-c1',
      conclusion: '合格',
      conclusionDate: '2024-03-13',
      isolationDays: 6,
      isolationUntil: '2024-03-19',
      note: '',
      version: 1,
      history: [historyEntry(1, '合格', '2024-03-13', 6, '')],
    }),
    quarantineRow({
      id: 'quarantine-seedling-c2',
      plotId: SEED_IDS.plotC,
      seedlingId: 'seedling-c2',
      conclusion: '合格',
      conclusionDate: '2024-03-17',
      isolationDays: 6,
      isolationUntil: '2024-03-23',
      note: '',
      version: 1,
      history: [historyEntry(1, '合格', '2024-03-17', 6, '')],
    }),
    quarantineRow({
      id: 'quarantine-seedling-a3',
      plotId: SEED_IDS.plotA,
      seedlingId: 'seedling-a3',
      conclusion: '不合格',
      conclusionDate: '2024-05-10',
      isolationDays: 0,
      isolationUntil: '',
      note: '发现疑似病虫害，退回处理前暂缓下滩',
      version: 2,
      history: [
        historyEntry(1, '待检', '', 7, '批次进场待检', SEED_TIME_PREV),
        historyEntry(2, '不合格', '2024-05-10', 0, '发现疑似病虫害，退回处理前暂缓下滩'),
      ],
    }),
    quarantineRow({
      id: 'quarantine-seedling-a4',
      plotId: SEED_IDS.plotA,
      seedlingId: 'seedling-a4',
      conclusion: '合格',
      conclusionDate: '2026-10-03',
      isolationDays: 10,
      isolationUntil: '2026-10-13',
      note: '隔离观察中，期满放行',
      version: 1,
      history: [historyEntry(1, '合格', '2026-10-03', 10, '隔离观察中，期满放行')],
    }),
  ];

  // ---------------- 班组放行申请（6 条已放行 + 2 条挂起） ----------------
  const releases: ReleaseRequest[] = [
    releaseRow({
      id: 'release-a1',
      plotId: SEED_IDS.plotA,
      seedlingId: 'seedling-a1',
      requestCount: 3200,
      applyDate: '2024-04-12',
      operator: '东港一班',
      state: '已放行',
      reason: '检疫合格（第 1 版），隔离期已于 2024-04-12 满，准予放行',
      releasedAt: '2024-04-12',
      basisVersion: 1,
      basisConclusion: '合格',
      basisIsolationUntil: '2024-04-12',
    }),
    releaseRow({
      id: 'release-a2',
      plotId: SEED_IDS.plotA,
      seedlingId: 'seedling-a2',
      requestCount: 2400,
      applyDate: '2024-04-20',
      operator: '东港二班',
      state: '已放行',
      reason: '检疫合格（第 2 版），隔离期已于 2024-04-20 满，准予放行',
      releasedAt: '2024-04-20',
      basisVersion: 2,
      basisConclusion: '复检合格',
      basisIsolationUntil: '2024-04-20',
    }),
    releaseRow({
      id: 'release-b1',
      plotId: SEED_IDS.plotB,
      seedlingId: 'seedling-b1',
      requestCount: 1900,
      applyDate: '2024-05-05',
      operator: '西湾一班',
      state: '已放行',
      reason: '检疫合格（第 1 版），隔离期已于 2024-05-05 满，准予放行',
      releasedAt: '2024-05-05',
      basisVersion: 1,
      basisConclusion: '合格',
      basisIsolationUntil: '2024-05-05',
    }),
    releaseRow({
      id: 'release-b2',
      plotId: SEED_IDS.plotB,
      seedlingId: 'seedling-b2',
      requestCount: 1600,
      applyDate: '2024-05-08',
      operator: '西湾二班',
      state: '已放行',
      reason: '检疫合格（第 1 版），隔离期已于 2024-05-08 满，准予放行',
      releasedAt: '2024-05-08',
      basisVersion: 1,
      basisConclusion: '合格',
      basisIsolationUntil: '2024-05-08',
    }),
    releaseRow({
      id: 'release-c1',
      plotId: SEED_IDS.plotC,
      seedlingId: 'seedling-c1',
      requestCount: 4400,
      applyDate: '2024-03-19',
      operator: '北屿一班',
      state: '已放行',
      reason: '检疫合格（第 1 版），隔离期已于 2024-03-19 满，准予放行',
      releasedAt: '2024-03-19',
      basisVersion: 1,
      basisConclusion: '合格',
      basisIsolationUntil: '2024-03-19',
    }),
    releaseRow({
      id: 'release-c2',
      plotId: SEED_IDS.plotC,
      seedlingId: 'seedling-c2',
      requestCount: 3900,
      applyDate: '2024-03-23',
      operator: '北屿二班',
      state: '已放行',
      reason: '检疫合格（第 1 版），隔离期已于 2024-03-23 满，准予放行',
      releasedAt: '2024-03-23',
      basisVersion: 1,
      basisConclusion: '合格',
      basisIsolationUntil: '2024-03-23',
    }),
    releaseRow({
      id: 'release-a3',
      plotId: SEED_IDS.plotA,
      seedlingId: 'seedling-a3',
      requestCount: 800,
      applyDate: '2024-05-09',
      operator: '东港一班',
      state: '挂起-不合格',
      reason: '检疫结论为「不合格」（第 2 版，2024-05-10），暂缓放行',
      releasedAt: '',
      basisVersion: null,
      basisConclusion: null,
      basisIsolationUntil: null,
    }),
    releaseRow({
      id: 'release-a4',
      plotId: SEED_IDS.plotA,
      seedlingId: 'seedling-a4',
      requestCount: 600,
      applyDate: '2026-10-04',
      operator: '东港一班',
      state: '挂起-隔离期',
      reason: '检疫合格（第 1 版），隔离期至 2026-10-13，期满后自动可放行',
      releasedAt: '',
      basisVersion: null,
      basisConclusion: null,
      basisIsolationUntil: null,
    }),
  ];

  // ---------------- 栽植记录（只引用已放行批次；写明放行依据） ----------------
  const plantings: Planting[] = [
    plantingRow({ id: 'planting-a1', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a1', releaseId: 'release-a1', basisVersion: 1, basisConclusion: '合格', plantDate: '2024-04-12', spacingM: 1, count: 3000, operator: '东港一班' }),
    // a2 依据的是第 2 版（复检合格）结论
    plantingRow({ id: 'planting-a2', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a2', releaseId: 'release-a2', basisVersion: 2, basisConclusion: '复检合格', plantDate: '2024-04-22', spacingM: 0.8, count: 2200, operator: '东港二班' }),
    plantingRow({ id: 'planting-b1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', releaseId: 'release-b1', basisVersion: 1, basisConclusion: '合格', plantDate: '2024-05-06', spacingM: 1.2, count: 1800, operator: '西湾一班' }),
    plantingRow({ id: 'planting-b2', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b2', releaseId: 'release-b2', basisVersion: 1, basisConclusion: '合格', plantDate: '2024-05-09', spacingM: 1, count: 1500, operator: '西湾二班' }),
    plantingRow({ id: 'planting-c1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', releaseId: 'release-c1', basisVersion: 1, basisConclusion: '合格', plantDate: '2024-03-20', spacingM: 1.5, count: 4200, operator: '北屿一班' }),
    plantingRow({ id: 'planting-c2', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c2', releaseId: 'release-c2', basisVersion: 1, basisConclusion: '合格', plantDate: '2024-03-24', spacingM: 1.2, count: 3800, operator: '北屿二班' }),
  ];

  // 各地块栽植总株数，用于派生成活率（挂起批 a3/a4 没有栽植行，不计入）
  const totalByPlot: Record<string, number> = {
    [SEED_IDS.plotA]: 5200,
    [SEED_IDS.plotB]: 3300,
    [SEED_IDS.plotC]: 8000,
  };

  // ---------------- 验收记录（每地块 2–3 个测次） ----------------
  const surveys: Survey[] = [
    surveyRow({ id: 'survey-a1', plotId: SEED_IDS.plotA, round: 1, date: '2024-06-20', aliveCount: 4680, avgHeightCm: 62 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a2', plotId: SEED_IDS.plotA, round: 2, date: '2024-09-18', aliveCount: 4420, avgHeightCm: 78 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a3', plotId: SEED_IDS.plotA, round: 3, date: '2025-03-15', aliveCount: 4108, avgHeightCm: 96 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-b1', plotId: SEED_IDS.plotB, round: 1, date: '2024-07-05', aliveCount: 2772, avgHeightCm: 41 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-b2', plotId: SEED_IDS.plotB, round: 2, date: '2024-10-12', aliveCount: 2112, avgHeightCm: 55 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-c1', plotId: SEED_IDS.plotC, round: 1, date: '2024-05-28', aliveCount: 7680, avgHeightCm: 70 }, totalByPlot[SEED_IDS.plotC]),
    surveyRow({ id: 'survey-c2', plotId: SEED_IDS.plotC, round: 2, date: '2024-08-30', aliveCount: 7440, avgHeightCm: 88 }, totalByPlot[SEED_IDS.plotC]),
  ];

  // ---------------- 补植计划（每地块 1 条，覆盖三种状态） ----------------
  const replants: Replant[] = [
    replantRow({ id: 'replant-a1', plotId: SEED_IDS.plotA, missingCount: 1092, planDate: '2025-04-10', species: '秋茄', state: '待补植' }),
    replantRow({ id: 'replant-b1', plotId: SEED_IDS.plotB, missingCount: 1188, planDate: '2025-04-18', species: '白骨壤', state: '已补植' }),
    replantRow({ id: 'replant-c1', plotId: SEED_IDS.plotC, missingCount: 560, planDate: '2024-11-05', species: '无瓣海桑', state: '已复核' }),
  ];

  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.quarantines, db.releases, db.plantings, db.surveys, db.replants],
    async () => {
      await db.plots.bulkPut(plots);
      await db.seedlings.bulkPut(seedlings);
      await db.quarantines.bulkPut(quarantines);
      await db.releases.bulkPut(releases);
      await db.plantings.bulkPut(plantings);
      await db.surveys.bulkPut(surveys);
      await db.replants.bulkPut(replants);
    },
  );
}
