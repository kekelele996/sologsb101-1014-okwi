/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：地块 → 苗木批次 / 栽植 → 验收 → 补植
 * 所有 id 固定，保证 /plots/:id/seedlings、/plots/:id/plantings 深链一定命中真实数据。
 */
import { db, ROW_REVISION } from './db';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant } from '../types/replant';
import type { Quarantine } from '../types/quarantine';
import type { ReleaseRequest } from '../types/release';
import { calcSurvivalRate, rateLevel } from './rate';
import { releaseSnapshotText } from './quarantine';

const SEED_TIME = '2025-01-06T02:00:00.000Z';

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

function quarantineRow(row: Omit<Quarantine, 'createdAt' | 'updatedAt' | 'revision'>): Quarantine {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function releaseRow(row: Omit<ReleaseRequest, 'createdAt' | 'updatedAt' | 'revision'>): ReleaseRequest {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
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

  // ---------------- 苗木批次（每地块 2 批，另留 1 批待检在隔离） ----------------
  const seedlings: Seedling[] = [
    seedlingRow({ id: 'seedling-a1', plotId: SEED_IDS.plotA, species: '秋茄', source: '自育苗', spec: '50cm 裸根苗', quantity: 3200, arrivalDate: '2024-04-05' }),
    seedlingRow({ id: 'seedling-a2', plotId: SEED_IDS.plotA, species: '桐花树', source: '外购', spec: '40cm 营养袋苗', quantity: 2400, arrivalDate: '2024-04-10' }),
    seedlingRow({ id: 'seedling-a3', plotId: SEED_IDS.plotA, species: '白骨壤', source: '外购', spec: '45cm 营养袋苗', quantity: 1500, arrivalDate: '2025-03-20' }),
    seedlingRow({ id: 'seedling-b1', plotId: SEED_IDS.plotB, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 1900, arrivalDate: '2024-04-28' }),
    seedlingRow({ id: 'seedling-b2', plotId: SEED_IDS.plotB, species: '秋茄', source: '外购', spec: '50cm 营养袋苗', quantity: 1600, arrivalDate: '2024-05-02' }),
    seedlingRow({ id: 'seedling-c1', plotId: SEED_IDS.plotC, species: '无瓣海桑', source: '外购', spec: '60cm 营养袋苗', quantity: 4400, arrivalDate: '2024-03-12' }),
    seedlingRow({ id: 'seedling-c2', plotId: SEED_IDS.plotC, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 3900, arrivalDate: '2024-03-16' }),
  ];

  // ---------------- 栽植记录（每地块 2 条，引用真实苗木批次） ----------------
  const plantings: Planting[] = [
    plantingRow({ id: 'planting-a1', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a1', plantDate: '2024-04-12', spacingM: 1, count: 3000, operator: '东港一班' }),
    plantingRow({ id: 'planting-a2', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a2', plantDate: '2024-04-15', spacingM: 0.8, count: 2200, operator: '东港二班' }),
    plantingRow({ id: 'planting-b1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', plantDate: '2024-05-06', spacingM: 1.2, count: 1800, operator: '西湾一班' }),
    plantingRow({ id: 'planting-b2', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b2', plantDate: '2024-05-09', spacingM: 1, count: 1500, operator: '西湾二班' }),
    plantingRow({ id: 'planting-c1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', plantDate: '2024-03-20', spacingM: 1.5, count: 4200, operator: '北屿一班' }),
    plantingRow({ id: 'planting-c2', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c2', plantDate: '2024-03-24', spacingM: 1.2, count: 3800, operator: '北屿二班' }),
  ];

  // 各地块栽植总株数，用于派生成活率
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

  // ---------------- 苗圃检疫档案（已栽植批次合格放行；a3 待检在隔离） ----------------
  const quarantines: Quarantine[] = [
    quarantineRow({
      id: 'quarantine-a1', seedlingId: 'seedling-a1', plotId: SEED_IDS.plotA, conclusion: '合格', version: 1,
      isolationDays: 7, isolatedFrom: '2024-04-05', inspectedDate: '2024-04-06', inspector: '市林检站 · 陈检疫', source: '苗圃登记',
    }),
    quarantineRow({
      id: 'quarantine-a2', seedlingId: 'seedling-a2', plotId: SEED_IDS.plotA, conclusion: '合格', version: 1,
      isolationDays: 5, isolatedFrom: '2024-04-10', inspectedDate: '2024-04-11', inspector: '市林检站 · 陈检疫', source: '苗圃登记',
    }),
    quarantineRow({
      id: 'quarantine-a3', seedlingId: 'seedling-a3', plotId: SEED_IDS.plotA, conclusion: '待检', version: 1,
      isolationDays: 10, isolatedFrom: '2025-03-20', inspectedDate: '', inspector: '', source: '苗圃登记',
    }),
    quarantineRow({
      id: 'quarantine-b1', seedlingId: 'seedling-b1', plotId: SEED_IDS.plotB, conclusion: '合格', version: 1,
      isolationDays: 7, isolatedFrom: '2024-04-28', inspectedDate: '2024-04-29', inspector: '区林检站 · 林检疫', source: '苗圃登记',
    }),
    quarantineRow({
      id: 'quarantine-b2', seedlingId: 'seedling-b2', plotId: SEED_IDS.plotB, conclusion: '合格', version: 1,
      isolationDays: 7, isolatedFrom: '2024-05-02', inspectedDate: '2024-05-03', inspector: '区林检站 · 林检疫', source: '苗圃登记',
    }),
    quarantineRow({
      id: 'quarantine-c1', seedlingId: 'seedling-c1', plotId: SEED_IDS.plotC, conclusion: '合格', version: 1,
      isolationDays: 7, isolatedFrom: '2024-03-12', inspectedDate: '2024-03-13', inspector: '省林检站 · 黄检疫', source: '苗圃登记',
    }),
    quarantineRow({
      id: 'quarantine-c2', seedlingId: 'seedling-c2', plotId: SEED_IDS.plotC, conclusion: '合格', version: 1,
      isolationDays: 7, isolatedFrom: '2024-03-16', inspectedDate: '2024-03-17', inspector: '省林检站 · 黄检疫', source: '苗圃登记',
    }),
  ];
  const quarantineBySeedling = new Map(quarantines.map((row) => [row.seedlingId, row]));

  // ---------------- 班组放行申请（6 批已放行；a3 没检疫结论挂起，不计栽植） ----------------
  const releasedSeedlingIds = ['seedling-a1', 'seedling-a2', 'seedling-b1', 'seedling-b2', 'seedling-c1', 'seedling-c2'] as const;
  const releasedAtBySeedling: Record<string, string> = {
    'seedling-a1': '2024-04-12',
    'seedling-a2': '2024-04-15',
    'seedling-b1': '2024-05-06',
    'seedling-b2': '2024-05-09',
    'seedling-c1': '2024-03-20',
    'seedling-c2': '2024-03-24',
  };
  const releaseRequests: ReleaseRequest[] = releasedSeedlingIds.map((seedlingId, index) => {
    const seedling = seedlings.find((row) => row.id === seedlingId)!;
    const quarantine = quarantineBySeedling.get(seedlingId)!;
    const releasedAt = releasedAtBySeedling[seedlingId];
    return releaseRow({
      id: `release-${index + 1}`,
      plotId: seedling.plotId,
      seedlingId,
      quantity: seedling.quantity,
      operator: '苗圃统一放行',
      requestDate: releasedAt,
      state: '已放行',
      holdReason: '',
      quarantineVersion: quarantine.version,
      releasedConclusion: releaseSnapshotText(quarantine),
      releasedAt,
    });
  });
  releaseRequests.push(
    releaseRow({
      id: 'release-a3',
      plotId: SEED_IDS.plotA,
      seedlingId: 'seedling-a3',
      quantity: 1500,
      operator: '东港一班',
      requestDate: '2025-03-22',
      state: '挂起',
      holdReason: '无检疫结论',
      quarantineVersion: 1,
      releasedConclusion: '',
      releasedAt: '',
    }),
  );

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
      await db.plots.bulkPut(plots);
      await db.seedlings.bulkPut(seedlings);
      await db.plantings.bulkPut(plantings);
      await db.surveys.bulkPut(surveys);
      await db.replants.bulkPut(replants);
      await db.quarantines.bulkPut(quarantines);
      await db.releaseRequests.bulkPut(releaseRequests);
    },
  );
}
