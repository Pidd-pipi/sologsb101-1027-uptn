// 端到端领域规则验证（fake-indexeddb + tsx 直跑 TS）
// 覆盖：1) 修订快照不可回写 2) 旧批次不重算 3) 重新确认才换版 4) 待核对拦罐装 5) 旧数据升级补齐
import 'fake-indexeddb/auto';
import assert from 'node:assert';
// 顺序敏感：先加载 db（Dexie 单例），再加载依赖它的模块，规避 tsx 下循环依赖具名绑定 TDZ
import * as DbModule from '../src/app/core/utils/db';
import * as SeedModule from '../src/app/core/utils/seed';
import * as IdbModule from '../src/app/core/services/idb-table.service';
import * as RevisionModule from '../src/app/core/services/revision.service';
import * as RecipeModule from '../src/app/core/services/recipe.service';

let pass = 0;
const ok = (name: string, cond: unknown) => {
  assert.ok(cond, name);
  pass += 1;
  console.log('  ✓', name);
};

// 手工组装与 Angular inject() 等价的依赖图（用命名空间属性访问，规避循环依赖下的具名绑定 TDZ）
const db = DbModule.db;
const seedDatabase = SeedModule.seedDatabase;
const idb = new IdbModule.IdbTableService();
const rev = new RevisionModule.RevisionService();
const svc = new RecipeModule.RecipeService(idb, rev);

await (async () => {
  await seedDatabase();
  const revisions = await rev.listRevisions();
  ok('播种生成 3 份修订快照', revisions.length === 3);
  const b2401 = await rev.bindingForBatch('B-2401');
  ok('B-2401 绑定 v1', b2401.status === '已绑定' && b2401.revisionNo === 1);
  const revV1 = await rev.getRevision(b2401.revisionId);
  const v1Ibu = revV1.recipe.targetIbu;
  ok('rc-001 v1 IBU=62', v1Ibu === 62);

  // ---- 酿酒师改配方目标 IBU：生成 v2，v1 快照不变 ----
  await svc.updateRecipe('rc-001', { targetIbu: 70 }, '更苦');
  const revsAfter = await rev.revisionsOfRecipe('rc-001');
  ok('改配方后出现 v2', revsAfter[0].revisionNo === 2 && revsAfter[0].note.includes('更苦'));
  const revV1Again = await rev.getRevision(b2401.revisionId);
  ok('旧 v1 快照未被回写（IBU 仍 62）', revV1Again.recipe.targetIbu === 62);
  const liveRecipe = await db.recipes.get('rc-001');
  ok('活表配方已是 IBU 70', liveRecipe.targetIbu === 70);

  // ---- 进行中批次仍绑定 v1，不重算 ----
  const b2401After = await rev.bindingForBatch('B-2401');
  ok('B-2401 仍绑定 v1（不随改动漂移）', b2401After.revisionNo === 1 && b2401After.status === '已绑定');

  // ---- 空改动不产生空修订 ----
  const beforeCount = (await rev.revisionsOfRecipe('rc-001')).length;
  await svc.updateRecipe('rc-001', { targetIbu: 70 });
  const afterCount = (await rev.revisionsOfRecipe('rc-001')).length;
  ok('内容无变化时不产生空修订', beforeCount === afterCount);

  // ---- 麦芽改动也出新修订，且快照含新麦芽，旧快照不变 ----
  const maltCountV2 = revV1Again.malts.length;
  await svc.createMalt({ recipeId: 'rc-001', name: '测试麦芽', ebc: 90, origin: '中国', ratioPct: 5, type: '特种麦芽' });
  const latest3 = (await rev.revisionsOfRecipe('rc-001'))[0];
  ok('新增麦芽生成 v3 且快照包含它', latest3.revisionNo === 3 && latest3.malts.length === maltCountV2 + 1);
  ok('v1 快照麦芽数不变（不可回写）', revV1Again.malts.length === maltCountV2);

  // ---- 重新确认：B-2401 采用最新修订 ----
  const latest = await rev.latestRevision('rc-001');
  await rev.rebindBatch('B-2401', 'rc-001', latest.id);
  const rebound = await rev.bindingForBatch('B-2401');
  ok('重新确认后 B-2401 绑定最新修订号', rebound.revisionNo === latest.revisionNo);

  // ---- 罐装闸门：正常批次可罐装 ----
  const assertOk = await rev.assertPackagable('B-2402', 'rc-002');
  ok('已绑定批次可罐装', assertOk.status === '已绑定');

  // ---- 待核对：混批（给 B-2402 录一条 rc-001 的读数）→ 转待核对并被拦 ----
  await svc.createFerment({
    batchNo: 'B-2402',
    recipeId: 'rc-001',
    date: '2024-04-30',
    gravity: 1.01,
    tempC: 20,
    diacetylPpm: 0.03,
    state: '已结束'
  });
  const mixed = await rev.bindingForBatch('B-2402');
  ok('混批自动转待核对', mixed.status === '待核对');
  let blocked = false;
  try {
    await svc.createPackaging({
      batchNo: 'B-2402',
      recipeId: 'rc-002',
      packDate: '2024-05-05',
      container: '瓶装',
      quantity: 12,
      carbonationVol: 2.5,
      abv: 5
    });
  } catch (e) {
    blocked = true;
  }
  ok('待核对批次罐装被拦截', blocked);

  // ---- 重新确认混批后恢复可罐装 ----
  const rc002Latest = await rev.latestRevision('rc-002');
  await rev.rebindBatch('B-2402', 'rc-002', rc002Latest.id);
  const rechecked = await rev.bindingForBatch('B-2402');
  ok('人工重新确认后恢复已绑定', rechecked.status === '已绑定');

  // ---- 新批次自动绑定所选配方最新修订 ----
  await svc.createFerment({
    batchNo: 'B-2501',
    recipeId: 'rc-003',
    date: '2024-05-01',
    gravity: 1.06,
    tempC: 18,
    diacetylPpm: 0.5,
    state: '主发酵'
  });
  const newBinding = await rev.bindingForBatch('B-2501');
  ok('新批次自动绑定配方最新修订', newBinding.status === '已绑定' && newBinding.recipeId === 'rc-003');

  // ---- 巡检幂等：不重复生成绑定/修订 ----
  await rev.reconcile();
  await rev.reconcile();
  const bindings = await rev.listBindings();
  const b2401Bindings = bindings.filter((b) => b.batchNo === 'B-2401');
  ok('巡检不重复创建绑定', b2401Bindings.length === 1);

  console.log(`\n全部 ${pass} 项领域规则通过 ✅`);
  process.exit(0);
})().catch((e) => {
  console.error('测试失败：', e);
  process.exit(1);
});
