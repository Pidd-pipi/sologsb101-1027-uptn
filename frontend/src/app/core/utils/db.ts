/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbbrewhouse-db，数据结构版本号 version(1) 与 upgrade() 迁移逻辑
 * - 配方 / 麦芽 / 酒花 / 糖化步 / 煮沸投加 / 发酵读数 / 罐装批次 七张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 */
import Dexie, { type Table, type Transaction } from 'dexie';
import type { Recipe } from '../models/recipe.model';
import type { Malt } from '../models/malt.model';
import type { Hop } from '../models/hop.model';
import type { MashStep } from '../models/mash-step.model';
import type { BoilAdd } from '../models/boil-add.model';
import type { Ferment } from '../models/ferment.model';
import type { Packaging } from '../models/packaging.model';
import {
  INITIAL_REVISION_NOTE,
  stripRowMeta,
  targetSnapshotOf,
  type RecipeRevision
} from '../models/recipe-revision.model';
import { nowIso, createId } from './uuid';
import { seedDatabase } from './seed';

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

/** 配方行：额外记录当前生效的修订快照 id */
export type RecipeRow = Recipe & Revisioned & { currentRevisionId?: string };
export type MaltRow = Malt & Revisioned;
export type HopRow = Hop & Revisioned;
export type MashStepRow = MashStep & Revisioned;
export type BoilAddRow = BoilAdd & Revisioned;
export type FermentRow = Ferment & Revisioned;
export type PackagingRow = Packaging & Revisioned;
/** 修订快照行：不可回写，无 updatedAt */
export type RecipeRevisionRow = RecipeRevision;

class GbBrewhouseDatabase extends Dexie {
  recipes!: Table<RecipeRow, string>;
  malts!: Table<MaltRow, string>;
  hops!: Table<HopRow, string>;
  mashSteps!: Table<MashStepRow, string>;
  boilAdds!: Table<BoilAddRow, string>;
  ferments!: Table<FermentRow, string>;
  packagings!: Table<PackagingRow, string>;
  recipeRevisions!: Table<RecipeRevisionRow, string>;

  constructor() {
    super(DB_NAME);

    this.version(DB_SCHEMA_VERSION)
      .stores({
        recipes: 'id, name, style, targetOg, updatedAt, currentRevisionId',
        malts: 'id, recipeId, name, ebc, type, updatedAt',
        hops: 'id, recipeId, name, alphaPct, form, updatedAt',
        mashSteps: 'id, recipeId, seq, state, updatedAt',
        boilAdds: 'id, recipeId, atMin, purpose, updatedAt',
        ferments: 'id, recipeId, batchNo, date, state, updatedAt, revisionId',
        packagings: 'id, recipeId, batchNo, packDate, container, updatedAt, revisionId',
        recipeRevisions: 'id, recipeId, revisionNo, createdAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移（version 1 → 2）：为历史配方补修订快照，并把旧发酵 / 罐装批次绑定到修订。
        // 新建库时各表为空，迁移天然幂等。
        await migrateToRevisions(tx);
      });
  }
}

export const db = new GbBrewhouseDatabase();

/**
 * 由配方及其当前从属数据构造一条修订快照（剔除 Dexie 行元数据后冻结）。
 * 不写库，仅返回快照对象，供迁移 / 播种 / 提交修订复用。
 */
export function buildRevisionSnapshot(
  recipe: RecipeRow,
  children: {
    malts: MaltRow[];
    hops: HopRow[];
    mashSteps: MashStepRow[];
    boilAdds: BoilAddRow[];
  },
  revisionNo: number,
  note: string,
  createdAt: number
): RecipeRevisionRow {
  return {
    id: createId('rev'),
    recipeId: recipe.id,
    revisionNo,
    createdAt,
    note,
    recipe: targetSnapshotOf(recipe),
    malts: children.malts.map(stripRowMeta),
    hops: children.hops.map(stripRowMeta),
    mashSteps: children.mashSteps.map(stripRowMeta),
    boilAdds: children.boilAdds.map(stripRowMeta)
  };
}

/**
 * version 1 → 2 迁移：
 * 1. 为每个已有配方创建初始修订快照（revisionNo = 1），冻结当前麦芽 / 酒花 / 糖化步 / 煮沸投加；
 * 2. 把配方的 currentRevisionId 指向该快照；
 * 3. 把每个发酵读数 / 罐装批次绑定到其配方的初始修订；配方缺失的批次保持 revisionId 为空（待核对）。
 */
async function migrateToRevisions(tx: Transaction): Promise<void> {
  const recipeTable = tx.table('recipes');
  const maltTable = tx.table('malts');
  const hopTable = tx.table('hops');
  const mashTable = tx.table('mashSteps');
  const boilTable = tx.table('boilAdds');
  const fermentTable = tx.table('ferments');
  const packagingTable = tx.table('packagings');
  const revisionTable = tx.table('recipeRevisions');

  const [recipes, malts, hops, mashSteps, boilAdds, ferments, packagings] = await Promise.all([
    recipeTable.toArray(),
    maltTable.toArray(),
    hopTable.toArray(),
    mashTable.toArray(),
    boilTable.toArray(),
    fermentTable.toArray(),
    packagingTable.toArray()
  ]);

  const now = Date.now();
  const revisions: RecipeRevisionRow[] = [];
  const currentRevisionByRecipe = new Map<string, string>();

  for (const recipe of recipes as RecipeRow[]) {
    const snapshot = buildRevisionSnapshot(
      recipe,
      {
        malts: (malts as MaltRow[]).filter((item) => item.recipeId === recipe.id),
        hops: (hops as HopRow[]).filter((item) => item.recipeId === recipe.id),
        mashSteps: (mashSteps as MashStepRow[]).filter((item) => item.recipeId === recipe.id),
        boilAdds: (boilAdds as BoilAddRow[]).filter((item) => item.recipeId === recipe.id)
      },
      1,
      INITIAL_REVISION_NOTE,
      now
    );
    revisions.push(snapshot);
    currentRevisionByRecipe.set(recipe.id, snapshot.id);
    await recipeTable.update(recipe.id, { currentRevisionId: snapshot.id });
  }

  if (revisions.length > 0) {
    await revisionTable.bulkPut(revisions);
  }

  // 绑定发酵读数：能解析到配方初始修订的写回 revisionId，否则留空（待核对）
  for (const row of ferments as FermentRow[]) {
    const revisionId = currentRevisionByRecipe.get(row.recipeId);
    if (revisionId) {
      await fermentTable.update(row.id, { revisionId });
    }
  }
  // 绑定罐装批次：同上，补不齐的拦住罐装
  for (const row of packagings as PackagingRow[]) {
    const revisionId = currentRevisionByRecipe.get(row.recipeId);
    if (revisionId) {
      await packagingTable.update(row.id, { revisionId });
    }
  }
}

/** 初始化 Promise 缓存：并发调用共享同一次「打开 + 按需播种」，避免重复灌入演示数据 */
let initPromise: Promise<void> | null = null;

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播；并发调用复用同一 Promise） */
export function initDatabase(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await db.open();
      if ((await db.recipes.count()) === 0) {
        await seedDatabase();
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

/** 删除配方：级联删除麦芽、酒花、糖化步、煮沸投加、发酵读数、罐装批次与全部修订快照 */
export async function removeRecipe(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.recipes, db.malts, db.hops, db.mashSteps, db.boilAdds, db.ferments, db.packagings, db.recipeRevisions],
    async () => {
      await db.malts.where('recipeId').equals(id).delete();
      await db.hops.where('recipeId').equals(id).delete();
      await db.mashSteps.where('recipeId').equals(id).delete();
      await db.boilAdds.where('recipeId').equals(id).delete();
      await db.ferments.where('recipeId').equals(id).delete();
      await db.packagings.where('recipeId').equals(id).delete();
      await db.recipeRevisions.where('recipeId').equals(id).delete();
      await db.recipes.delete(id);
    }
  );
}

/* ----------------------------- 配方修订快照 ----------------------------- */

/** 全部修订快照（按配方与修订序号排序） */
export async function listRevisions(): Promise<RecipeRevisionRow[]> {
  const rows = await db.recipeRevisions.toArray();
  return rows.sort((a, b) =>
    a.recipeId === b.recipeId ? a.revisionNo - b.revisionNo : a.recipeId.localeCompare(b.recipeId)
  );
}

/** 某配方的全部修订快照（按修订序号升序） */
export async function listRevisionsByRecipe(recipeId: string): Promise<RecipeRevisionRow[]> {
  const rows = await db.recipeRevisions.where('recipeId').equals(recipeId).toArray();
  return rows.sort((a, b) => a.revisionNo - b.revisionNo);
}

/** 读取单条修订快照 */
export async function getRevision(id: string): Promise<RecipeRevisionRow | undefined> {
  return db.recipeRevisions.get(id);
}

/**
 * 提交一条新修订快照：冻结配方当前目标值与麦芽 / 酒花 / 糖化步 / 煮沸投加，
 * 递增修订序号，并把配方的 currentRevisionId 指向新快照。快照不可回写。
 */
export async function commitRecipeRevision(recipeId: string, note = ''): Promise<RecipeRevisionRow> {
  const revision = await db.transaction('rw', [db.recipes, db.malts, db.hops, db.mashSteps, db.boilAdds, db.recipeRevisions], async () => {
    const recipe = await db.recipes.get(recipeId);
    if (!recipe) throw new Error('配方不存在，无法提交修订');
    const [malts, hops, mashSteps, boilAdds, existing] = await Promise.all([
      db.malts.where('recipeId').equals(recipeId).toArray(),
      db.hops.where('recipeId').equals(recipeId).toArray(),
      db.mashSteps.where('recipeId').equals(recipeId).toArray(),
      db.boilAdds.where('recipeId').equals(recipeId).toArray(),
      db.recipeRevisions.where('recipeId').equals(recipeId).toArray()
    ]);
    const revisionNo = existing.reduce((max, row) => Math.max(max, row.revisionNo), 0) + 1;
    const snapshot = buildRevisionSnapshot(
      recipe,
      { malts, hops, mashSteps, boilAdds },
      revisionNo,
      note || (revisionNo === 1 ? INITIAL_REVISION_NOTE : `第 ${revisionNo} 次修订`),
      Date.now()
    );
    await db.recipeRevisions.put(snapshot);
    await db.recipes.update(recipeId, { currentRevisionId: snapshot.id, updatedAt: Date.now() });
    return snapshot;
  });
  return revision;
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
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [recipes, malts, hops, mashSteps, boilAdds, ferments, packagings, recipeRevisions] = await Promise.all([
    db.recipes.toArray(),
    db.malts.toArray(),
    db.hops.toArray(),
    db.mashSteps.toArray(),
    db.boilAdds.toArray(),
    db.ferments.toArray(),
    db.packagings.toArray(),
    db.recipeRevisions.toArray()
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
    recipeRevisions: recipeRevisions.map((row) => ({ ...row }))
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.recipes, db.malts, db.hops, db.mashSteps, db.boilAdds, db.ferments, db.packagings, db.recipeRevisions],
    async () => {
      await Promise.all([
        db.recipes.clear(),
        db.malts.clear(),
        db.hops.clear(),
        db.mashSteps.clear(),
        db.boilAdds.clear(),
        db.ferments.clear(),
        db.packagings.clear(),
        db.recipeRevisions.clear()
      ]);
      await db.recipes.bulkPut(snapshot.recipes.map(stamp));
      await db.malts.bulkPut(snapshot.malts.map(stamp));
      await db.hops.bulkPut(snapshot.hops.map(stamp));
      await db.mashSteps.bulkPut(snapshot.mashSteps.map(stamp));
      await db.boilAdds.bulkPut(snapshot.boilAdds.map(stamp));
      await db.ferments.bulkPut(snapshot.ferments.map(stamp));
      await db.packagings.bulkPut(snapshot.packagings.map(stamp));
      await db.recipeRevisions.bulkPut((snapshot.recipeRevisions ?? []).map((row) => ({ ...row })));
    }
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.recipes, db.malts, db.hops, db.mashSteps, db.boilAdds, db.ferments, db.packagings, db.recipeRevisions],
    async () => {
      await Promise.all([
        db.recipes.clear(),
        db.malts.clear(),
        db.hops.clear(),
        db.mashSteps.clear(),
        db.boilAdds.clear(),
        db.ferments.clear(),
        db.packagings.clear(),
        db.recipeRevisions.clear()
      ]);
    }
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [recipes, malts, hops, mashSteps, boilAdds, ferments, packagings, recipeRevisions] = await Promise.all([
    db.recipes.count(),
    db.malts.count(),
    db.hops.count(),
    db.mashSteps.count(),
    db.boilAdds.count(),
    db.ferments.count(),
    db.packagings.count(),
    db.recipeRevisions.count()
  ]);
  return { recipes, malts, hops, mashSteps, boilAdds, ferments, packagings, recipeRevisions };
}
