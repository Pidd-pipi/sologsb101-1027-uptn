/**
 * 配方修订与批次绑定模型
 * - RecipeRevision：不可回写的配方修订快照。酿酒师每次改动配方（目标值 / 麦芽 / 酒花 / 糖化步 / 煮沸投加）
 *   都会生成一条新修订，快照内对象一经生成不再被任何编辑改写。
 * - BatchBinding：发酵批次（按批次号）与某个配方修订之间的绑定。进行中批次始终沿用绑定修订的目标值，
 *   配方改动不会让旧批次重算；批次要采用新配方必须显式「重新确认」；旧数据补不齐绑定时标记为待核对。
 */
import type { Recipe } from './recipe.model';
import type { Malt } from './malt.model';
import type { Hop } from './hop.model';
import type { MashStep } from './mash-step.model';
import type { BoilAdd } from './boil-add.model';

/** 配方修订快照（不可回写） */
export interface RecipeRevision {
  id: string;
  /** 所属配方 */
  recipeId: string;
  /** 修订序号（同一配方内从 1 递增） */
  revisionNo: number;
  /** 修订说明（新建 / 目标值修改 / 投料调整等） */
  note: string;
  /** 配方头快照（目标 OG / FG / IBU / EBC / 批次体积） */
  recipe: Recipe;
  /** 麦芽投料快照 */
  malts: Malt[];
  /** 酒花投料快照 */
  hops: Hop[];
  /** 糖化升温步快照 */
  mashSteps: MashStep[];
  /** 煮沸投加快照 */
  boilAdds: BoilAdd[];
}

/** 批次绑定状态：已绑定修订 / 待人工核对 */
export type BatchBindingStatus = '已绑定' | '待核对';

export const BATCH_BINDING_STATUSES: BatchBindingStatus[] = ['已绑定', '待核对'];

/** 批次 → 配方修订的绑定（一个批次号一条） */
export interface BatchBinding {
  id: string;
  /** 批次号（唯一） */
  batchNo: string;
  /** 绑定的配方 */
  recipeId: string;
  /** 绑定的修订快照 id（待核对时可能为空串） */
  revisionId: string;
  /** 绑定的修订号（待核对时为 0） */
  revisionNo: number;
  /** 绑定状态 */
  status: BatchBindingStatus;
  /** 绑定 / 异常说明 */
  note?: string;
  /** 首次绑定时间戳 */
  boundAt: number;
}

/** 修订号展示文本 */
export function revisionLabel(no: number): string {
  return no > 0 ? `v${no}` : '未修订';
}

/** 绑定状态展示文本 */
export function bindingStatusLabel(status: BatchBindingStatus): string {
  return status === '待核对' ? '待核对' : '已绑定';
}
