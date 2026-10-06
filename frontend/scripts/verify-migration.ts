/* 端到端校验 v2→v3 迁移 + 检疫/放行/栽植/补植联动（跑在 fake-indexeddb 上，非页面运行时） */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

async function assert(cond: boolean, msg: string): Promise<void> {
  if (!cond) throw new Error('断言失败：' + msg);
  console.log('  ✓ ' + msg);
}

/* ---------- 1) 构造一个 v2 旧库（无检疫/放行表） ---------- */
{
  const old = new Dexie('gbmangrove');
  old.version(1).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
    seedlings: 'id, plotId, species, source, arrivalDate',
    plantings: 'id, plotId, seedlingId, plantDate',
    surveys: 'id, plotId, round, date',
    replants: 'id, plotId, planDate, state',
  });
  old.version(2).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
    seedlings: 'id, plotId, species, source, arrivalDate, quantity',
    plantings: 'id, plotId, seedlingId, plantDate, spacingM',
    surveys: 'id, plotId, [plotId+round], date, grade',
    replants: 'id, plotId, planDate, state, species',
  });
  await old.open();
  await old.table('plots').bulkPut([
    { id: 'p1', name: '旧地块', areaMu: 10, tideZone: '中', substrate: '淤泥质', restoreMode: '造林', state: '跟踪中', missingCount: 0, lastReplantDate: '', createdAt: 't', updatedAt: 't', revision: 2 },
  ]);
  await old.table('seedlings').bulkPut([
    // 有到场日期：应补「待检」
    { id: 's1', plotId: 'p1', species: '秋茄', source: '自育苗', spec: 'x', quantity: 100, arrivalDate: '2024-04-05', createdAt: 't', updatedAt: 't', revision: 2 },
    // 到场日期缺失：补不上，先搁着，不建档
    { id: 's2', plotId: 'p1', species: '桐花树', source: '外购', spec: 'y', quantity: 50, arrivalDate: '', createdAt: 't', updatedAt: 't', revision: 2 },
  ]);
  await old.table('plantings').bulkPut([
    { id: 'pl1', plotId: 'p1', seedlingId: 's1', plantDate: '2024-04-12', spacingM: 1, count: 80, operator: '班一', createdAt: 't', updatedAt: 't', revision: 2 },
  ]);
  await old.close();
  console.log('v2 旧库构造完成（s1 有到场日期、s2 无到场日期、s1 已有栽植）');
}

/* ---------- 2) 用当前代码打开，触发 v2→v3 迁移 ---------- */
const { db, initDatabase } = await import('../src/utils/db');
await initDatabase();
console.log('打开当前库（应自动升级到 v3）');

{
  const quarantines = await db.quarantines.toArray();
  await assert(quarantines.length === 1, '只给 1 批补了待检档案（s2 到场日期补不上先搁着）');
  const q1 = quarantines.find((q) => q.seedlingId === 's1')!;
  await assert(q1.conclusion === '待检' && q1.source === '升级补录', 's1 补的是「待检/升级补录」，隔离起算取到场日期');
  await assert(q1.isolatedFrom === '2024-04-05', '隔离起算日期 = 到场日期 2024-04-05');
}

{
  const releases = await db.releaseRequests.toArray();
  await assert(releases.length === 1 && releases[0].state === '已放行', '既有栽植引用的 s1 补一条已放行，历史栽植照旧留底');
  await assert(releases[0].releasedConclusion.includes('第 1 版'), '放行依据写明第 1 版结论');
}

/* ---------- 3) 班组对新批 s2（待检）报放行 → 应挂起，不计栽植 ---------- */
const { useReleaseStore } = await import('../src/stores/releaseStore');
let r2 = await useReleaseStore.getState().applyRelease(
  { plotId: 'p1', seedlingId: 's2', quantity: 50, operator: '班二', requestDate: '2026-10-06' },
  undefined,
);
await assert(r2.state === '挂起' && r2.holdReason === '无检疫结论', '没检疫的 s2 放行申请先挂起（无检疫结论）');
{
  const rel = await db.releaseRequests.toArray();
  const releasedIds = new Set(rel.filter((x) => x.state === '已放行').map((x) => x.seedlingId));
  const plantings = await db.plantings.toArray();
  const total = plantings.filter((p) => p.plotId === 'p1' && releasedIds.has(p.seedlingId)).reduce((a, p) => a + p.count, 0);
  await assert(total === 80, '栽植总株数只算已放行批次 = 80（挂起的 s2 不计入）');
}

/* ---------- 4) 苗圃给出「合格 + 隔离 10 天」，今天仍在隔离期 → 重算仍挂起 ---------- */
const { useNurseryStore } = await import('../src/stores/nurseryStore');
const s2 = await db.seedlings.get('s2')!;
let res = await useNurseryStore.getState().saveQuarantine(s2, {
  conclusion: '合格', isolationDays: 10, isolatedFrom: '2026-10-01', inspectedDate: '2026-10-06', inspector: '检疫员',
});
await assert(res.ok === true, '苗圃侧保存检疫结论成功');
{
  const q = (await db.quarantines.where('seedlingId').equals('s2').toArray())[0];
  await assert(q.version === 1, '首次出结论为第 1 版');
  const open = await db.releaseRequests.where('seedlingId').equals('s2').toArray();
  const held = open.find((x) => x.state === '挂起');
  await assert(held !== undefined && held.holdReason === '隔离期内', '合格但隔离未满，未放行申请跟着重算为「挂起/隔离期内」');
}

/* ---------- 5) 隔离期满后再重算 → 自动放行，固化第 1 版 ---------- */
const changed = await useReleaseStore.getState().refreshFromQuarantine();
// refreshFromQuarantine 用今天（2026-10-06）；改判定基准到隔离期满后
await import('../src/utils/db').then(async (m) => {
  const n = await m.recalcOpenReleaseRequests(undefined, '2026-10-12');
  await assert(n >= 1, '隔离期满后重算至少改动 1 条申请');
});
{
  const rel = (await db.releaseRequests.where('seedlingId').equals('s2').toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  await assert(rel.state === '已放行' && rel.releasedConclusion.includes('第 1 版'), '隔离期满后按第 1 版结论放行并留底');
}

/* ---------- 6) 放行后苗圃再改结论（不合格，升 v2）→ 已放行的不动 ---------- */
await useNurseryStore.getState().saveQuarantine(s2, {
  conclusion: '不合格', isolationDays: 10, isolatedFrom: '2026-10-01', inspectedDate: '2026-10-12', inspector: '检疫员',
});
{
  const q = (await db.quarantines.where('seedlingId').equals('s2').toArray())[0];
  await assert(q.version === 2, '结论改动升到第 2 版');
  const rel = (await db.releaseRequests.where('seedlingId').equals('s2').toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  await assert(rel.state === '已放行' && rel.releasedConclusion.includes('第 1 版'), '已放行/已栽下去的照旧留着，仍写明依据第 1 版');
  const plantings = await db.plantings.toArray();
  await assert(plantings.length === 1 && plantings[0].count === 80, '班组栽植记录未被苗圃保存动作改动');
}

/* ---------- 7) 已放行的 s1 补植完成回写只统计已放行批次（不被挂起影响） ---------- */
{
  const { selectReleasedSeedlingIds } = await import('../src/stores/releaseStore');
  const rel = await db.releaseRequests.toArray();
  const ids = selectReleasedSeedlingIds(rel);
  await assert(ids.has('s1'), 's1 仍在已放行集合中');
}

console.log('\n全部端到端断言通过 ✅');
void changed;
await db.close();
process.exit(0);
