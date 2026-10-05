import 'fake-indexeddb/auto';
import assert from 'node:assert';
import * as DbModule from '../src/app/core/utils/db';
import * as SeedModule from '../src/app/core/utils/seed';
import * as IdbModule from '../src/app/core/services/idb-table.service';
import * as RevisionModule from '../src/app/core/services/revision.service';
import * as RecipeModule from '../src/app/core/services/recipe.service';
const ok=(n:string,c:unknown)=>{assert.ok(c,n);console.log('  ✓',n)};
const db=DbModule.db;
const idb=new IdbModule.IdbTableService();
const rev=new RevisionModule.RevisionService();
const svc=new RecipeModule.RecipeService(idb,rev);
await (async()=>{
  await SeedModule.seedDatabase();

  // 糖化步「完成状态」修改不应误删旧快照，且产生新修订
  const ms = (await db.mashSteps.where('recipeId').equals('rc-002').toArray()).find(s=>s.state!=='已完成')!;
  const before = await rev.latestRevision('rc-002');
  await svc.updateMashStep(ms.id, { state: '已完成' });
  const after = await rev.latestRevision('rc-002');
  ok('签署糖化步完成也出新修订', after.revisionNo === before.revisionNo + 1);
  const oldSnap = await rev.getRevision(before.id);
  ok('旧糖化步快照保留原状态（不可回写）', oldSnap.mashSteps.some(s=>s.id===ms.id && s.state!=='已完成' ));

  // 删除配方级联清理修订与绑定
  await svc.createRecipe({ name:'临时', style:'IPA', targetOg:1.04,targetFg:1.01,targetIbu:30,targetEbc:10,batchSizeL:20 });
  const temp = (await db.recipes.toArray()).find(r=>r.name==='临时')!;
  await svc.createFerment({ batchNo:'TMP-1', recipeId:temp.id, date:'2024-06-01', gravity:1.04, tempC:18, diacetylPpm:0.5, state:'主发酵' });
  ok('临时批次已绑定', (await rev.bindingForBatch('TMP-1'))?.status==='已绑定');
  await svc.deleteRecipe(temp.id);
  ok('删除配方级联删除修订', (await db.recipeRevisions.where('recipeId').equals(temp.id).count())===0);
  ok('删除配方级联删除批次绑定', (await rev.bindingForBatch('TMP-1'))===undefined);

  // 导入快照：旧备份（无 revision/binding 字段）导入后 reconcile 兜底补齐
  const snap:any = {
    name:DbModule.DB_NAME, schemaVersion:1, exportedAt:new Date().toISOString(),
    recipes:[{id:'r1',name:'导入配方',style:'世涛',targetOg:1.07,targetFg:1.02,targetIbu:35,targetEbc:60,batchSizeL:18}],
    malts:[],hops:[],mashSteps:[],boilAdds:[],
    ferments:[{id:'x1',batchNo:'IMP-1',recipeId:'r1',date:'2024-07-01',gravity:1.07,tempC:18,diacetylPpm:0.6,state:'主发酵'}],
    packagings:[]
  };
  await DbModule.importSnapshot(snap);
  await rev.reconcile();
  const ib = await rev.bindingForBatch('IMP-1');
  ok('导入旧备份后批次自动补齐绑定', ib?.status==='已绑定' && ib.revisionNo===1);
  const ir = await rev.latestRevision('r1');
  ok('导入旧备份后补齐修订快照', ir?.revisionNo===1 && ir.recipe.targetEbc===60);

  console.log('\n边界场景全部通过 ✅'); process.exit(0);
})().catch(e=>{console.error('失败',e);process.exit(1)});
