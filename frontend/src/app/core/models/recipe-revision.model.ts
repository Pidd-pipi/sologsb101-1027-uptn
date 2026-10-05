/**
 * 配方修订快照模型
 *
 * 酿酒师改完配方后，旧发酵批次会套上新的目标值、罐装档案也跟着变 —— 这是因为配方被「原地回写」了。
 * 修复方式：把每次配方改动收成一条不可回写的修订快照。
 *  - 麦芽、酒花、糖化步、煮沸投加在修订创建时被冻结进快照；
 *  - 发酵 / 罐装批次通过 revisionId 绑定到具体修订，配方后续改动不会重算旧批次；
 *  - 批次要采用新配方时必须显式「重新确认」改绑。
 */
import type { BeerStyle } from './recipe.model';
import type { Malt } from './malt.model';
import type { Hop } from './hop.model';
import type { MashStep } from './mash-step.model';
import type { BoilAdd } from './boil-add.model';

/** 修订快照冻结的配方目标值 */
export interface RecipeTargetSnapshot {
  name: string;
  style: BeerStyle;
  targetOg: number;
  targetFg: number;
  targetIbu: number;
  targetEbc: number;
  batchSizeL: number;
}

/**
 * 配方修订快照：一次配方改动对应一条不可回写的快照。
 * 快照一经创建不再修改（无 updatedAt），只能追加新修订。
 */
export interface RecipeRevision {
  id: string;
  /** 所属配方 */
  recipeId: string;
  /** 修订序号，从 1 递增 */
  revisionNo: number;
  /** 创建时间戳 ms */
  createdAt: number;
  /** 改动说明（自动生成或手工备注） */
  note: string;
  /** 冻结的配方目标值 */
  recipe: RecipeTargetSnapshot;
  /** 冻结的麦芽投料 */
  malts: Malt[];
  /** 冻结的酒花投加 */
  hops: Hop[];
  /** 冻结的糖化升温步 */
  mashSteps: MashStep[];
  /** 冻结的煮沸投加 */
  boilAdds: BoilAdd[];
}

/** 批次绑定状态：已绑定具体修订 / 待核对（补不齐快照） */
export type RevisionBindingState = '已绑定' | '待核对';

/** 初始修订说明 */
export const INITIAL_REVISION_NOTE = '初始配方';

/** 行结构元数据键（冻结快照时剔除 Dexie 簿记字段） */
const ROW_META_KEYS = ['revision', 'createdAt', 'updatedAt'] as const;

/** 剔除 Dexie 行元数据，得到可冻结的子领域对象 */
export function stripRowMeta<T>(row: T): T {
  const copy = { ...row } as Record<string, unknown>;
  for (const key of ROW_META_KEYS) {
    delete copy[key];
  }
  return copy as T;
}

/** 由配方目标值构造快照头 */
export function targetSnapshotOf(recipe: {
  name: string;
  style: BeerStyle;
  targetOg: number;
  targetFg: number;
  targetIbu: number;
  targetEbc: number;
  batchSizeL: number;
}): RecipeTargetSnapshot {
  return {
    name: recipe.name,
    style: recipe.style,
    targetOg: recipe.targetOg,
    targetFg: recipe.targetFg,
    targetIbu: recipe.targetIbu,
    targetEbc: recipe.targetEbc,
    batchSizeL: recipe.batchSizeL
  };
}
