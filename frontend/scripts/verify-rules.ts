/**
 * 运行时验证脚本（不入构建产物）：核心业务规则冒烟测试
 * 用 fake-indexeddb 在 Node 下验证：
 * 1) v3 迁移：旧批次按到场日期补待检，缺日期的搁置；
 * 2) 班组放行：没检疫/隔离期未满挂起，挂起批不进栽植总株数、不出补植；
 * 3) 结论改动：未放行申请重算，已放行不动且保留依据版本；
 * 4) 苗圃保存只重试自己：模拟 quarantines 写失败，确认 plantings 未被触碰。
 */
import 'fake-indexeddb/auto';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${msg}`);
  }
};

async function main(): Promise<void> {
  // 先模拟一个 v2 老库：只有 plots/seedlings/plantings，无检疫结论
  const { Dexie } = await import('dexie');
  const oldDb = new Dexie('gbmangrove');
  oldDb.version(2).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
    seedlings: 'id, plotId, species, source, arrivalDate, quantity',
    plantings: 'id, plotId, seedlingId, plantDate, spacingM',
    surveys: 'id, plotId, [plotId+round], date, grade',
    replants: 'id, plotId, planDate, state, species',
  });
  await oldDb.open();
  const oldNow = '2025-01-01T00:00:00.000Z';
  await (oldDb.table('plots') as unknown as { bulkAdd: (r: unknown[]) => Promise<unknown> }).bulkAdd([
    { id: 'p1', name: '老地块', areaMu: 10, tideZone: '中', substrate: '淤泥质', restoreMode: '造林', state: '跟踪中', missingCount: 0, lastReplantDate: '', createdAt: oldNow, updatedAt: oldNow, revision: 2 },
  ]);
  await (oldDb.table('seedlings') as unknown as { bulkAdd: (r: unknown[]) => Promise<unknown> }).bulkAdd([
    { id: 's-ok', plotId: 'p1', species: '秋茄', source: '自育苗', spec: '50cm', quantity: 100, arrivalDate: '2024-04-01', createdAt: oldNow, updatedAt: oldNow, revision: 2 },
    { id: 's-nodate', plotId: 'p1', species: '桐花树', source: '外购', spec: '40cm', quantity: 50, arrivalDate: '', createdAt: oldNow, updatedAt: oldNow, revision: 2 },
    { id: 's-baddate', plotId: 'p1', species: '白骨壤', source: '外购', spec: '45cm', quantity: 30, arrivalDate: '四月', createdAt: oldNow, updatedAt: oldNow, revision: 2 },
  ]);
  // 升级前已栽下去的旧记录：照旧保留、无放行依据
  await (oldDb.table('plantings') as unknown as { add: (r: unknown) => Promise<unknown> }).add({
    id: 'pl-old', plotId: 'p1', seedlingId: 's-ok', plantDate: '2024-05-01', spacingM: 1, count: 80, operator: '一班',
    createdAt: oldNow, updatedAt: oldNow, revision: 2,
  });
  oldDb.close();

  // 重新以 v3 打开，触发升级迁移
  const dbModule = await import('../src/utils/db');
  await dbModule.db.open();

  const quarantines = await dbModule.db.quarantines.toArray();
  const qSeedlingIds = quarantines.map((q) => q.seedlingId).sort();
  assert(JSON.stringify(qSeedlingIds) === JSON.stringify(['s-ok']), '迁移：只有到场日期有效的 s-ok 补了待检，缺/坏日期的搁置');
  assert(quarantines[0].conclusion === '待检' && quarantines[0].version === 1, '迁移：补的是第 1 版「待检」，注明来源为到场日期');

  const oldPlanting = await dbModule.db.plantings.get('pl-old');
  assert(!!oldPlanting && oldPlanting.count === 80, '迁移：升级前栽下去的记录照旧保留');
  assert(oldPlanting!.releaseId === undefined && oldPlanting!.basisVersion === undefined, '迁移：旧栽植无放行依据字段');

  // 旧栽植仍计入栽植总株数（80）
  const totalOld = (await dbModule.db.plantings.where('plotId').equals('p1').toArray()).reduce((a, r) => a + r.count, 0);
  assert(totalOld === 80, '口径：升级前栽植 80 株仍计入栽植总株数');

  // ---- 班组给 s-ok 报放行：待检 → 应挂起（待检） ----
  let r1 = await dbModule.applyRelease(
    { plotId: 'p1', seedlingId: 's-ok', requestCount: 100, applyDate: '2026-10-06', operator: '一班' },
    await dbModule.getQuarantineBySeedling('s-ok'),
  );
  assert(r1.state === '挂起-待检' && r1.releasedAt === '', '规则：没检疫结论时申请挂起-待检，不计栽植');

  // ---- 苗圃出「合格」结论，隔离期到 2026-10-08；今天 2026-10-06，应转挂起-隔离期 ----
  const save1 = await dbModule.saveQuarantineConclusion('s-ok', {
    conclusion: '合格', conclusionDate: '2026-10-06', isolationDays: 2, note: '',
  });
  assert(save1.changed && save1.row.version === 2, '版本：出结论从待检→合格，版本升到 2');
  assert(save1.row.history.length === 2, '留痕：history 保留两版');
  r1 = (await dbModule.getReleaseBySeedling('s-ok'))!;
  assert(r1.state === '挂起-隔离期' && r1.releasedAt === '', '规则：隔离期未满自动重算为挂起-隔离期');

  // ---- 跨天重算：2026-10-08 隔离期满 → 已放行，写明依据 v2 ----
  await dbModule.refreshHeldReleases('2026-10-08');
  r1 = (await dbModule.getReleaseBySeedling('s-ok'))!;
  assert(r1.state === '已放行' && r1.basisVersion === 2 && r1.basisConclusion === '合格', '规则：隔离期满转已放行，依据第 2 版');
  assert(r1.releasedAt === '2026-10-08', '规则：放行日期记为判定日');

  // ---- 放行后苗圃又改结论（不合格），已放行不动 ----
  await dbModule.saveQuarantineConclusion('s-ok', {
    conclusion: '不合格', conclusionDate: '2026-10-09', isolationDays: 0, note: '复查异常',
  });
  await dbModule.refreshHeldReleases('2026-10-09');
  r1 = (await dbModule.getReleaseBySeedling('s-ok'))!;
  assert(r1.state === '已放行' && r1.basisVersion === 2, '终态：结论再改动，已放行申请不重算、依据仍为 v2');
  const qAfter = await dbModule.getQuarantineBySeedling('s-ok');
  assert(qAfter!.version === 3 && qAfter!.history.length === 3, '苗圃侧：检疫账照常升到第 3 版并留痕');

  // ---- 不合格的新批次申请：挂起-不合格 ----
  // 给搁置批次补登待检，再出不合格
  const sBad = await dbModule.db.seedlings.get('s-nodate');
  await dbModule.ensurePendingQuarantine(sBad!, 'manual');
  await dbModule.saveQuarantineConclusion('s-nodate', {
    conclusion: '不合格', conclusionDate: '2026-10-06', isolationDays: 0, note: '',
  });
  const r2 = await dbModule.applyRelease(
    { plotId: 'p1', seedlingId: 's-nodate', requestCount: 50, applyDate: '2026-10-06', operator: '二班' },
    await dbModule.getQuarantineBySeedling('s-nodate'),
  );
  assert(r2.state === '挂起-不合格', '规则：不合格批次挂起-不合格');

  // 挂起批没有栽植行 → 栽植总株数仍是旧的 80，不会为 s-nodate 出补植
  const plantings = await dbModule.db.plantings.where('plotId').equals('p1').toArray();
  const total = plantings.reduce((a, r) => a + r.count, 0);
  assert(total === 80, '核心：两批挂起苗（共 150 株）都不计进栽植总株数，总株数仍为 80');
  const held = (await dbModule.db.releases.where('plotId').equals('p1').toArray()).filter((x) => x.state !== '已放行');
  assert(held.length === 1, '核心：当前挂起申请 1 条（s-nodate），s-ok 已放行');

  // ---- 苗圃保存失败只重试自己：让 quarantines.put 抛错，确认 plantings 数据不动 ----
  const beforePlantings = await dbModule.db.plantings.toArray();
  const realPut = dbModule.db.quarantines.put.bind(dbModule.db.quarantines);
  let attempts = 0;
  dbModule.db.quarantines.put = (() => {
    attempts += 1;
    return Promise.reject(new Error('simulated nursery write failure'));
  }) as typeof dbModule.db.quarantines.put;
  let failed = false;
  try {
    await dbModule.saveQuarantineConclusion('s-ok', { conclusion: '合格', conclusionDate: '2026-10-10', isolationDays: 1, note: '' });
  } catch {
    failed = true;
  } finally {
    dbModule.db.quarantines.put = realPut;
  }
  assert(failed, '重试：苗圃保存最终失败时抛错（已重试）');
  assert(attempts === 3, `重试：苗圃自己的写操作共尝试 3 次（1+2），实际 ${attempts} 次`);
  const afterPlantings = await dbModule.db.plantings.toArray();
  assert(afterPlantings.length === beforePlantings.length, '隔离：苗圃失败重试全程没有触碰班组栽植记录');

  // ---- 快照含两张新表且旧存档可导入 ----
  const snap = await dbModule.exportSnapshot();
  assert(Array.isArray(snap.quarantines) && Array.isArray(snap.releases), '快照：含 quarantines / releases 两表');
  const { parseSnapshot } = await import('../src/utils/export');
  const oldStyle = {
    name: 'gbmangrove', schemaVersion: 2, exportedAt: new Date().toISOString(),
    plots: [], seedlings: [], plantings: [], surveys: [], replants: [],
  };
  const parsed = parseSnapshot(JSON.stringify(oldStyle));
  assert(parsed.ok, '兼容：v2 旧存档（无两新表）也能通过校验');

  console.log('\n全部规则验证完成。');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
