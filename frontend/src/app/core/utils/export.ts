/**
 * 配方 JSON 序列化与校验
 * 罐装页用于导出配方实绩档案，也是「导入导出备份」的数据校验入口。
 * 档案以「配方最新修订快照」为准（不可回写），并附批次绑定关系以体现版本与影响范围。
 */
import type { Recipe } from '../models/recipe.model';
import type { Malt } from '../models/malt.model';
import type { Hop } from '../models/hop.model';
import type { MashStep } from '../models/mash-step.model';
import type { BoilAdd } from '../models/boil-add.model';
import type { Ferment } from '../models/ferment.model';
import type { Packaging } from '../models/packaging.model';
import type { BatchBinding, RecipeRevision } from '../models/revision.model';
import { DB_NAME, DB_SCHEMA_VERSION, db } from './db';
import { abvFromGravity, apparentAttenuation, totalGrainKg, weightedEbc } from './brew';
import { nowIso } from './uuid';

/** 配方实绩档案 */
export interface RecipeArchive {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  /** 活表配方头（当前最新值） */
  recipe: Recipe;
  /** 最新修订号 */
  revisionNo: number;
  /** 档案所依据的修订快照（不可回写） */
  revision: RecipeRevision | null;
  malts: Malt[];
  hops: Hop[];
  mashSteps: MashStep[];
  boilAdds: BoilAdd[];
  ferments: Ferment[];
  packagings: Packaging[];
  /** 该配方各批次的修订绑定（版本关系 / 影响范围） */
  batchBindings: BatchBinding[];
  summary: {
    maltCount: number;
    hopCount: number;
    mashStepCount: number;
    boilAddCount: number;
    fermentCount: number;
    grainKg: number;
    avgEbc: number;
    og: number;
    fg: number;
    abv: number;
    attenuation: number;
    packagedQuantity: number;
    pendingBatchCount: number;
  };
}

type WithRevision = {
  revision?: number;
  createdAt?: number;
  updatedAt?: number;
};

function stripRevision<T extends WithRevision>(row: T): T {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as T;
}

/** 汇总某个配方的实绩档案（以最新修订快照为准） */
export async function buildRecipeArchive(recipeId: string): Promise<RecipeArchive> {
  const recipe = await db.recipes.get(recipeId);
  if (!recipe) throw new Error('配方不存在，无法导出档案');

  const revisionRows = await db.recipeRevisions.where('recipeId').equals(recipeId).toArray();
  const latestRevisionRow = revisionRows.sort((a, b) => b.revisionNo - a.revisionNo)[0] ?? null;
  const latestRevision: RecipeRevision | null = latestRevisionRow
    ? (() => {
        const { createdAt: _createdAt, ...rest } = latestRevisionRow;
        return rest;
      })()
    : null;

  // 档案的工艺内容取最新修订快照（不可回写），没有快照时回退活表，保证旧数据也能导出
  const [malts, hops, mashSteps, boilAdds, ferments, packagings, bindings] = await Promise.all([
    db.malts.where('recipeId').equals(recipeId).toArray(),
    db.hops.where('recipeId').equals(recipeId).toArray(),
    db.mashSteps.where('recipeId').equals(recipeId).toArray(),
    db.boilAdds.where('recipeId').equals(recipeId).toArray(),
    db.ferments.where('recipeId').equals(recipeId).toArray(),
    db.packagings.where('recipeId').equals(recipeId).toArray(),
    db.batchBindings.where('recipeId').equals(recipeId).toArray()
  ]);

  const archiveMalts = latestRevision ? latestRevision.malts : malts.map(stripRevision);
  const archiveHops = latestRevision ? latestRevision.hops : hops.map(stripRevision);
  const archiveMashSteps = latestRevision
    ? latestRevision.mashSteps
    : mashSteps.map(stripRevision).sort((a, b) => a.seq - b.seq);
  const archiveBoilAdds = latestRevision ? latestRevision.boilAdds : boilAdds.map(stripRevision);
  const archiveRecipe = latestRevision ? latestRevision.recipe : stripRevision(recipe);

  const sortedFerments = [...ferments].sort((a, b) => a.date.localeCompare(b.date));
  const og = sortedFerments.length > 0 ? sortedFerments[0].gravity : archiveRecipe.targetOg;
  const fg = sortedFerments.length > 0 ? sortedFerments[sortedFerments.length - 1].gravity : archiveRecipe.targetFg;

  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    recipe: stripRevision(recipe),
    revisionNo: latestRevisionRow?.revisionNo ?? 0,
    revision: latestRevision,
    malts: archiveMalts,
    hops: archiveHops,
    mashSteps: archiveMashSteps,
    boilAdds: archiveBoilAdds,
    ferments: sortedFerments.map(stripRevision),
    packagings: packagings.map(stripRevision),
    batchBindings: bindings.map(stripRevision),
    summary: {
      maltCount: archiveMalts.length,
      hopCount: archiveHops.length,
      mashStepCount: archiveMashSteps.length,
      boilAddCount: archiveBoilAdds.length,
      fermentCount: ferments.length,
      grainKg: totalGrainKg(archiveRecipe.batchSizeL, archiveRecipe.targetOg),
      avgEbc: weightedEbc(archiveMalts),
      og,
      fg,
      abv: abvFromGravity(og, fg),
      attenuation: apparentAttenuation(og, fg),
      packagedQuantity: packagings.reduce((sum, item) => sum + item.quantity, 0),
      pendingBatchCount: bindings.filter((item) => item.status === '待核对').length
    }
  };
}

export function serializeArchive(archive: RecipeArchive): string {
  return JSON.stringify(archive, null, 2);
}

/** 校验并解析档案 / 备份 JSON，失败时抛出可读错误 */
export function parseArchive(text: string): RecipeArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文本');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('档案根节点必须是对象');
  }
  const candidate = parsed as Partial<RecipeArchive>;
  if (typeof candidate.name !== 'string') throw new Error('缺少 name 字段');
  if (typeof candidate.schemaVersion !== 'number') throw new Error('缺少 schemaVersion 字段');
  if (!candidate.recipe || typeof candidate.recipe.id !== 'string') throw new Error('缺少 recipe.id 字段');
  if (!Array.isArray(candidate.malts)) throw new Error('malts 必须是数组');
  return candidate as RecipeArchive;
}

/** 触发浏览器下载（纯前端，无需后端） */
export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
