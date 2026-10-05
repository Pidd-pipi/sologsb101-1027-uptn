/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbbrewhouse-db
 * - version(1)：配方 / 麦芽 / 酒花 / 糖化步 / 煮沸投加 / 发酵读数 / 罐装批次 七张表
 * - version(2)：新增 recipeRevisions（不可回写的配方修订快照）与 batchBindings（批次绑定）两张表；
 *   升级迁移会为旧数据补齐修订快照与批次绑定，补不齐的绑定标记为「待核对」并拦住罐装。
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie';
import type { Recipe } from '../models/recipe.model';
import type { Malt } from '../models/malt.model';
import type { Hop } from '../models/hop.model';
import type { MashStep } from '../models/mash-step.model';
import type { BoilAdd } from '../models/boil-add.model';
import type { Ferment } from '../models/ferment.model';
import type { Packaging } from '../models/packaging.model';
import type { BatchBinding, RecipeRevision } from '../models/revision.model';
import { nowIso } from './uuid';

/** 数据库名 */
export const DB_NAME = 'gbbrewhouse-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号 */
export const ROW_REVISION = 1;

export interface Revisioned {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type RecipeRow = Recipe & Revisioned;
export type MaltRow = Malt & Revisioned;
export type HopRow = Hop & Revisioned;
export type MashStepRow = MashStep & Revisioned;
export type BoilAddRow = BoilAdd & Revisioned;
export type FermentRow = Ferment & Revisioned;
export type PackagingRow = Packaging & Revisioned;
/** 配方修订快照行（快照不可回写，仅带创建时间戳） */
export type RecipeRevisionRow = RecipeRevision & { createdAt: number };
/** 批次绑定行 */
export type BatchBindingRow = BatchBinding & Revisioned;

class GbBrewhouseDatabase extends Dexie {
  recipes!: Table<RecipeRow, string>;
  malts!: Table<MaltRow, string>;
  hops!: Table<HopRow, string>;
  mashSteps!: Table<MashStepRow, string>;
  boilAdds!: Table<BoilAddRow, string>;
  ferments!: Table<FermentRow, string>;
  packagings!: Table<PackagingRow, string>;
  recipeRevisions!: Table<RecipeRevisionRow, string>;
  batchBindings!: Table<BatchBindingRow, string>;

  constructor() {
    super(DB_NAME);

    this.version(1).stores({
      recipes: 'id, name, style, targetOg, updatedAt',
      malts: 'id, recipeId, name, ebc, type, updatedAt',
      hops: 'id, recipeId, name, alphaPct, form, updatedAt',
      mashSteps: 'id, recipeId, seq, state, updatedAt',
      boilAdds: 'id, recipeId, atMin, purpose, updatedAt',
      ferments: 'id, recipeId, batchNo, date, state, updatedAt',
      packagings: 'id, recipeId, batchNo, packDate, container, updatedAt'
    });

    this.version(2)
      .stores({
        recipes: 'id, name, style, targetOg, updatedAt',
        malts: 'id, recipeId, name, ebc, type, updatedAt',
        hops: 'id, recipeId, name, alphaPct, form, updatedAt',
        mashSteps: 'id, recipeId, seq, state, updatedAt',
        boilAdds: 'id, recipeId, atMin, purpose, updatedAt',
        ferments: 'id, recipeId, batchNo, date, state, updatedAt',
        packagings: 'id, recipeId, batchNo, packDate, container, updatedAt',
        recipeRevisions: 'id, recipeId, revisionNo, createdAt',
        batchBindings: 'id, batchNo, recipeId, revisionId, status, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = [
          'recipes',
          'malts',
          'hops',
          'mashSteps',
          'boilAdds',
          'ferments',
          'packagings'
        ];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }

        // 旧数据升级：按现有配方各拍一张 v1 修订快照，并为每个发酵 / 罐装批次补齐绑定；
        // 批次找不到配方（或批次号为空）时补不齐，标记为「待核对」并拦住罐装。
        const stampNow = Date.now();
        const legacyRecipes = (await tx.table('recipes').toArray()) as RecipeRow[];
        const legacyMalts = (await tx.table('malts').toArray()) as MaltRow[];
        const legacyHops = (await tx.table('hops').toArray()) as HopRow[];
        const legacyMashSteps = (await tx.table('mashSteps').toArray()) as MashStepRow[];
        const legacyBoilAdds = (await tx.table('boilAdds').toArray()) as BoilAddRow[];
        const legacyFerments = (await tx.table('ferments').toArray()) as FermentRow[];
        const legacyPackagings = (await tx.table('packagings').toArray()) as PackagingRow[];

        const revisionByRecipe = new Map<string, RecipeRevisionRow>();
        for (const recipe of legacyRecipes) {
          const row: RecipeRevisionRow = {
            id: `rv-upgrade-${recipe.id}`,
            recipeId: recipe.id,
            revisionNo: 1,
            note: '旧数据升级：自动补齐的初始修订快照',
            createdAt: stampNow,
            recipe: stripSnapshotFields(recipe),
            malts: legacyMalts.filter((item) => item.recipeId === recipe.id).map(stripSnapshotFields),
            hops: legacyHops.filter((item) => item.recipeId === recipe.id).map(stripSnapshotFields),
            mashSteps: legacyMashSteps
              .filter((item) => item.recipeId === recipe.id)
              .map(stripSnapshotFields)
              .sort((a, b) => a.seq - b.seq),
            boilAdds: legacyBoilAdds.filter((item) => item.recipeId === recipe.id).map(stripSnapshotFields)
          };
          revisionByRecipe.set(recipe.id, row);
        }
        if (revisionByRecipe.size > 0) {
          await tx.table('recipeRevisions').bulkPut([...revisionByRecipe.values()]);
        }

        const recipeIds = new Set(legacyRecipes.map((item) => item.id));
        const batches = new Map<string, { recipeId: string }>();
        for (const item of [...legacyFerments, ...legacyPackagings]) {
          if (!item.batchNo || !item.recipeId) continue;
          if (!batches.has(item.batchNo)) batches.set(item.batchNo, { recipeId: item.recipeId });
        }

        const bindingRows: BatchBindingRow[] = [];
        let pendingSeq = 0;
        for (const [batchNo, { recipeId }] of batches) {
          const revision = recipeIds.has(recipeId) ? revisionByRecipe.get(recipeId) : undefined;
          const isPending = !revision;
          bindingRows.push({
            id: `bd-upgrade-${batchNo}`,
            batchNo,
            recipeId: revision ? recipeId : '',
            revisionId: revision?.id ?? '',
            revisionNo: revision?.revisionNo ?? 0,
            status: isPending ? '待核对' : '已绑定',
            note: isPending ? '旧数据升级：批次的配方已不存在或无法判定，请人工核对后再罐装' : '旧数据升级：自动绑定初始修订',
            boundAt: stampNow,
            revision: ROW_REVISION,
            createdAt: stampNow,
            updatedAt: stampNow
          });
          if (isPending) pendingSeq += 1;
        }
        // 找不到批次号的孤儿发酵 / 罐装行无法归属批次，单列一条待核对绑定提醒人工处理
        const orphanRows = [...legacyFerments, ...legacyPackagings].filter(
          (item) => !item.batchNo || !item.recipeId
        );
        if (orphanRows.length > 0 || bindingRows.length === 0) {
          if (orphanRows.length > 0) {
            bindingRows.push({
              id: `bd-upgrade-pending-${pendingSeq + 1}`,
              batchNo: '',
              recipeId: '',
              revisionId: '',
              revisionNo: 0,
              status: '待核对',
              note: `旧数据升级：${orphanRows.length} 条发酵 / 罐装记录缺少批次号或配方，待人工核对`,
              boundAt: stampNow,
              revision: ROW_REVISION,
              createdAt: stampNow,
              updatedAt: stampNow
            });
          }
        }
        if (bindingRows.length > 0) {
          await tx.table('batchBindings').bulkPut(bindingRows);
        }
      });
  }
}

/** 去掉行级修订号 / 时间戳，只留业务字段进入快照 */
function stripSnapshotFields<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

export const db = new GbBrewhouseDatabase();

/**
 * 初始化 Promise 缓存：并发调用共享同一次「打开 + 按需播种」，避免重复灌入演示数据。
 * seeder 由调用方注入（seed.ts 反过来依赖本模块，注入可打破循环依赖，保证具名导出在运行时可用）。
 */
let initPromise: Promise<void> | null = null;

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播；并发调用复用同一 Promise） */
export function initDatabase(seeder: () => Promise<void>): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await db.open();
      if ((await db.recipes.count()) === 0) {
        await seeder();
      }
    })().catch((error: unknown) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

/* ------------------------------ 配方 ------------------------------ */

export async function listRecipes(): Promise<RecipeRow[]> {
  const rows = await db.recipes.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 删除配方：级联删除麦芽、酒花、糖化步、煮沸投加、发酵读数、罐装批次、修订快照与批次绑定 */
export async function removeRecipe(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.recipes,
      db.malts,
      db.hops,
      db.mashSteps,
      db.boilAdds,
      db.ferments,
      db.packagings,
      db.recipeRevisions,
      db.batchBindings
    ],
    async () => {
      // 先找出该配方涉及的批次号，再删批次绑定
      const batchNos = new Set<string>();
      const ferments = await db.ferments.where('recipeId').equals(id).toArray();
      const packagings = await db.packagings.where('recipeId').equals(id).toArray();
      ferments.forEach((item) => item.batchNo && batchNos.add(item.batchNo));
      packagings.forEach((item) => item.batchNo && batchNos.add(item.batchNo));
      await db.malts.where('recipeId').equals(id).delete();
      await db.hops.where('recipeId').equals(id).delete();
      await db.mashSteps.where('recipeId').equals(id).delete();
      await db.boilAdds.where('recipeId').equals(id).delete();
      await db.ferments.where('recipeId').equals(id).delete();
      await db.packagings.where('recipeId').equals(id).delete();
      await db.recipeRevisions.where('recipeId').equals(id).delete();
      if (batchNos.size > 0) {
        await db.batchBindings.where('batchNo').anyOf([...batchNos]).delete();
      }
      await db.recipes.delete(id);
    }
  );
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  recipes: Recipe[];
  malts: Malt[];
  hops: Hop[];
  mashSteps: MashStep[];
  boilAdds: BoilAdd[];
  ferments: Ferment[];
  packagings: Packaging[];
  recipeRevisions: RecipeRevision[];
  batchBindings: BatchBinding[];
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

function stripRevisionRow(row: RecipeRevisionRow): RecipeRevision {
  const copy: RecipeRevision = {
    id: row.id,
    recipeId: row.recipeId,
    revisionNo: row.revisionNo,
    note: row.note,
    recipe: row.recipe,
    malts: row.malts,
    hops: row.hops,
    mashSteps: row.mashSteps,
    boilAdds: row.boilAdds
  };
  return copy;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [
    recipes,
    malts,
    hops,
    mashSteps,
    boilAdds,
    ferments,
    packagings,
    recipeRevisions,
    batchBindings
  ] = await Promise.all([
    db.recipes.toArray(),
    db.malts.toArray(),
    db.hops.toArray(),
    db.mashSteps.toArray(),
    db.boilAdds.toArray(),
    db.ferments.toArray(),
    db.packagings.toArray(),
    db.recipeRevisions.toArray(),
    db.batchBindings.toArray()
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    recipes: recipes.map(stripRow),
    malts: malts.map(stripRow),
    hops: hops.map(stripRow),
    mashSteps: mashSteps.map(stripRow),
    boilAdds: boilAdds.map(stripRow),
    ferments: ferments.map(stripRow),
    packagings: packagings.map(stripRow),
    recipeRevisions: recipeRevisions.map(stripRevisionRow),
    batchBindings: batchBindings.map(stripRow)
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

function stampRevision(row: RecipeRevision): RecipeRevisionRow {
  return { ...row, createdAt: Date.now() };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.recipes,
      db.malts,
      db.hops,
      db.mashSteps,
      db.boilAdds,
      db.ferments,
      db.packagings,
      db.recipeRevisions,
      db.batchBindings
    ],
    async () => {
      await Promise.all([
        db.recipes.clear(),
        db.malts.clear(),
        db.hops.clear(),
        db.mashSteps.clear(),
        db.boilAdds.clear(),
        db.ferments.clear(),
        db.packagings.clear(),
        db.recipeRevisions.clear(),
        db.batchBindings.clear()
      ]);
      await db.recipes.bulkPut(snapshot.recipes.map(stamp));
      await db.malts.bulkPut(snapshot.malts.map(stamp));
      await db.hops.bulkPut(snapshot.hops.map(stamp));
      await db.mashSteps.bulkPut(snapshot.mashSteps.map(stamp));
      await db.boilAdds.bulkPut(snapshot.boilAdds.map(stamp));
      await db.ferments.bulkPut(snapshot.ferments.map(stamp));
      await db.packagings.bulkPut(snapshot.packagings.map(stamp));
      // 旧备份可能没有修订 / 绑定数据：导入后由修订服务的兜底逻辑补齐
      if (Array.isArray(snapshot.recipeRevisions)) {
        await db.recipeRevisions.bulkPut(snapshot.recipeRevisions.map(stampRevision));
      }
      if (Array.isArray(snapshot.batchBindings)) {
        await db.batchBindings.bulkPut(snapshot.batchBindings.map(stamp));
      }
    }
  );
}

/** 清空全部业务表（播种逻辑放在 seed.ts，避免与本模块形成循环依赖） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.recipes,
      db.malts,
      db.hops,
      db.mashSteps,
      db.boilAdds,
      db.ferments,
      db.packagings,
      db.recipeRevisions,
      db.batchBindings
    ],
    async () => {
      await Promise.all([
        db.recipes.clear(),
        db.malts.clear(),
        db.hops.clear(),
        db.mashSteps.clear(),
        db.boilAdds.clear(),
        db.ferments.clear(),
        db.packagings.clear(),
        db.recipeRevisions.clear(),
        db.batchBindings.clear()
      ]);
    }
  );
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [
    recipes,
    malts,
    hops,
    mashSteps,
    boilAdds,
    ferments,
    packagings,
    recipeRevisions,
    batchBindings
  ] = await Promise.all([
    db.recipes.count(),
    db.malts.count(),
    db.hops.count(),
    db.mashSteps.count(),
    db.boilAdds.count(),
    db.ferments.count(),
    db.packagings.count(),
    db.recipeRevisions.count(),
    db.batchBindings.count()
  ]);
  return { recipes, malts, hops, mashSteps, boilAdds, ferments, packagings, recipeRevisions, batchBindings };
}
