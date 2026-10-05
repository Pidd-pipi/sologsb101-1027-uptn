// v1 旧库 → v2 升级迁移验证：
// 先用只有 7 张表的 v1 结构灌入旧数据（含配方缺失的孤儿批次、缺批次号记录），
// 再用正式的 v2 数据库打开，断言升级后补齐修订快照 / 批次绑定，补不齐的显示「待核对」。
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import assert from 'node:assert';
import * as DbModule from '../src/app/core/utils/db';
import * as RevisionModule from '../src/app/core/services/revision.service';

let pass = 0;
const ok = (name: string, cond: unknown) => {
  assert.ok(cond, name);
  pass += 1;
  console.log('  ✓', name);
};

await (async () => {
  // 1) 用 v1 结构直接建一个「旧库」
  const legacy = new Dexie(DbModule.DB_NAME);
  legacy.version(1).stores({
    recipes: 'id, name, style, targetOg, updatedAt',
    malts: 'id, recipeId, name, ebc, type, updatedAt',
    hops: 'id, recipeId, name, alphaPct, form, updatedAt',
    mashSteps: 'id, recipeId, seq, state, updatedAt',
    boilAdds: 'id, recipeId, atMin, purpose, updatedAt',
    ferments: 'id, recipeId, batchNo, date, state, updatedAt',
    packagings: 'id, recipeId, batchNo, packDate, container, updatedAt'
  });

  const now = Date.now();
  await legacy.table('recipes').bulkPut([
    { id: 'rc-x', name: '旧配方', style: 'IPA', targetOg: 1.05, targetFg: 1.01, targetIbu: 40, targetEbc: 12, batchSizeL: 20 },
    { id: 'rc-y', name: '另一配方', style: '拉格', targetOg: 1.045, targetFg: 1.008, targetIbu: 20, targetEbc: 6, batchSizeL: 30 }
  ]);
  await legacy.table('malts').bulkPut([
    { id: 'm1', recipeId: 'rc-x', name: '基础麦芽', ebc: 4, origin: '德国', ratioPct: 100, type: '基础麦芽' }
  ]);
  await legacy.table('ferments').bulkPut([
    // 正常批次（rc-x）
    { id: 'f1', batchNo: 'OLD-1', recipeId: 'rc-x', date: '2024-01-01', gravity: 1.05, tempC: 18, diacetylPpm: 0.5, state: '主发酵' },
    { id: 'f2', batchNo: 'OLD-1', recipeId: 'rc-x', date: '2024-01-05', gravity: 1.012, tempC: 18, diacetylPpm: 0.05, state: '已结束' },
    // 混批：OLD-2 同时出现两个配方
    { id: 'f3', batchNo: 'OLD-2', recipeId: 'rc-x', date: '2024-02-01', gravity: 1.05, tempC: 18, diacetylPpm: 0.5, state: '主发酵' },
    { id: 'f4', batchNo: 'OLD-2', recipeId: 'rc-y', date: '2024-02-02', gravity: 1.045, tempC: 16, diacetylPpm: 0.4, state: '主发酵' },
    // 孤儿：缺批次号
    { id: 'f5', batchNo: '', recipeId: 'rc-x', date: '2024-02-03', gravity: 1.05, tempC: 18, diacetylPpm: 0.5, state: '主发酵' }
  ]);
  await legacy.table('packagings').bulkPut([
    { id: 'p1', batchNo: 'OLD-1', recipeId: 'rc-x', packDate: '2024-01-10', container: '瓶装', quantity: 24, carbonationVol: 2.5, abv: 5 }
  ]);
  await legacy.close();
  ok('v1 旧数据已灌入（无修订 / 绑定表）', true);

  // 2) 正式打开 v2（触发 upgrade 迁移）
  await DbModule.db.open();
  ok('数据库升级到结构 v2', DbModule.db.verno === 2);

  // 3) 断言迁移补齐结果
  const revisions = await DbModule.db.recipeRevisions.toArray();
  ok('每个旧配方补齐 1 张 v1 修订快照', revisions.length === 2 && revisions.every((r) => r.revisionNo === 1));
  const revX = revisions.find((r) => r.recipeId === 'rc-x');
  ok('修订快照包含旧配方的麦芽行', revX && revX.malts.length === 1 && revX.malts[0].id === 'm1');
  ok('快照配方头为旧目标值（IBU 40）', revX && revX.recipe.targetIbu === 40);

  const rev = new RevisionModule.RevisionService();
  await rev.reconcile(); // 迁移已处理，reconcile 再兜底一遍，验证幂等
  const bindings = await DbModule.db.batchBindings.toArray();

  const old1 = bindings.find((b) => b.batchNo === 'OLD-1');
  ok('正常批次 OLD-1 自动绑定已补齐的 v1', old1 && old1.status === '已绑定' && old1.revisionNo === 1 && old1.recipeId === 'rc-x');

  const old2 = bindings.find((b) => b.batchNo === 'OLD-2');
  ok('混批 OLD-2 标记为待核对', old2 && old2.status === '待核对');

  const orphan = bindings.find((b) => b.id === 'bd-pending-orphan');
  ok('缺批次号孤儿记录产生待核对提醒', orphan && orphan.status === '待核对');

  // 4) 待核对批次必须被罐装闸门拦住
  let blocked = false;
  try {
    await rev.assertPackagable('OLD-2');
  } catch {
    blocked = true;
  }
  ok('待核对的 OLD-2 被罐装闸门拦截', blocked);

  // 5) 正常批次放行
  const pass1 = await rev.assertPackagable('OLD-1');
  ok('已绑定的 OLD-1 允许罐装', pass1.status === '已绑定');

  // 6) 迁移幂等：再次 reconcile 不重复建绑定
  const countBefore = (await DbModule.db.batchBindings.toArray()).length;
  await rev.reconcile();
  const countAfter = (await DbModule.db.batchBindings.toArray()).length;
  ok('reconcile 幂等，不重复创建绑定', countBefore === countAfter);

  console.log(`\n旧数据升级迁移 ${pass} 项全部通过 ✅`);
  process.exit(0);
})().catch((e) => {
  console.error('迁移测试失败：', e);
  process.exit(1);
});
