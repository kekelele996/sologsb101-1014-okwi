/* 校验：苗圃侧保存失败时只重试自己，班组栽植记录不动 */
import 'fake-indexeddb/auto';

async function assert(cond: boolean, msg: string): Promise<void> {
  if (!cond) throw new Error('断言失败：' + msg);
  console.log('  ✓ ' + msg);
}

// initDatabase 会在空库播种，这里先播种再追加我们自己的隔离地块，避免与演示数据混淆
const { db, initDatabase } = await import('../src/utils/db');
await initDatabase();
await db.plots.put({ id: 'retryp', name: '重试隔离地块', areaMu: 10, tideZone: '中', substrate: '淤泥质', restoreMode: '造林', state: '跟踪中', missingCount: 0, lastReplantDate: '', createdAt: 't', updatedAt: 't', revision: 3 });
await db.seedlings.put({ id: 'retrys', plotId: 'retryp', species: '秋茄', source: '自育苗', spec: 'x', quantity: 100, arrivalDate: '2026-10-01', createdAt: 't', updatedAt: 't', revision: 3 });
await db.plantings.put({ id: 'retrypl', plotId: 'retryp', seedlingId: 'retrys', plantDate: '2026-10-05', spacingM: 1, count: 60, operator: '班', createdAt: 't', updatedAt: 't', revision: 3 });
const plantingBefore = JSON.stringify(await db.plantings.get('retrypl'));

const { useNurseryStore } = await import('../src/stores/nurseryStore');
const seedling = (await db.seedlings.get('retrys'))!;

// 前两次保存失败、第三次成功：应只重试苗圃自己
let putCalls = 0;
const originalPut = db.quarantines.put.bind(db.quarantines);
db.quarantines.put = ((...args: unknown[]) => {
  putCalls += 1;
  if (putCalls < 3) return Promise.reject(new Error('模拟 IndexedDB 写入失败'));
  return originalPut(...(args as [never]));
}) as typeof db.quarantines.put;

const result = await useNurseryStore.getState().saveQuarantine(seedling, {
  conclusion: '合格', isolationDays: 0, isolatedFrom: '2026-10-01', inspectedDate: '2026-10-06', inspector: '员',
});
await assert(result.ok === true, '苗圃侧最终保存成功');
await assert(putCalls === 3, `失败后只重试苗圃自己（共尝试 ${putCalls} 次 = 3）`);

// 始终失败：不抛到页面之外，班组栽植记录不动
db.quarantines.put = () => Promise.reject(new Error('始终失败'));
const failResult = await useNurseryStore.getState().saveQuarantine(seedling, {
  conclusion: '不合格', isolationDays: 0, isolatedFrom: '2026-10-01', inspectedDate: '2026-10-06', inspector: '员',
});
await assert(failResult.ok === false && failResult.attempts === 3, '始终失败时返回失败且尝试 3 次，不抛异常');

const plantingAfter = JSON.stringify(await db.plantings.get('retrypl'));
await assert(plantingBefore === plantingAfter, '班组栽植记录完全没被苗圃保存失败/重试触动');

const q = await db.quarantines.where('seedlingId').equals('retrys').toArray();
await assert(q.length === 1 && q[0].conclusion === '合格', '成功保存的档案保留；后续失败没有覆盖它');

console.log('\n苗圃侧重试隔离断言通过 ✅');
await db.close();
process.exit(0);
