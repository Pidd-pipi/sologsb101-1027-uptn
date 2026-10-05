/**
 * 批次绑定状态解析（纯函数）。
 * 发酵 / 罐装批次通过 revisionId 绑定到具体修订快照；
 * 绑定的快照存在且归属该配方 → 已绑定，否则 → 待核对。
 */
import type { RecipeRevision, RevisionBindingState } from '../models/recipe-revision.model';

/** 批次绑定状态描述 */
export interface BindingInfo {
  /** 已绑定具体修订 / 待核对 */
  state: RevisionBindingState;
  /** 绑定到的修订快照（待核对时为 null） */
  revision: RecipeRevision | null;
  /** 绑定的修订序号 */
  revisionNo: number | null;
  /** 配方当前（最新）修订序号 */
  currentRevisionNo: number | null;
  /** 配方当前修订 id */
  currentRevisionId: string | null;
  /** 绑定的是否为最新修订 */
  isLatest: boolean;
}

/** 解析一条批次行（发酵 / 罐装）的绑定状态 */
export function resolveBinding(
  row: { recipeId: string; revisionId?: string },
  revisions: RecipeRevision[]
): BindingInfo {
  const own = revisions
    .filter((item) => item.recipeId === row.recipeId)
    .sort((a, b) => b.revisionNo - a.revisionNo);
  const current = own[0] ?? null;
  const bound = row.revisionId
    ? revisions.find((item) => item.id === row.revisionId && item.recipeId === row.recipeId) ?? null
    : null;

  if (!bound) {
    return {
      state: '待核对',
      revision: null,
      revisionNo: null,
      currentRevisionNo: current?.revisionNo ?? null,
      currentRevisionId: current?.id ?? null,
      isLatest: false
    };
  }
  return {
    state: '已绑定',
    revision: bound,
    revisionNo: bound.revisionNo,
    currentRevisionNo: current?.revisionNo ?? bound.revisionNo,
    currentRevisionId: current?.id ?? bound.id,
    isLatest: current ? bound.id === current.id : true
  };
}

/** 某配方的全部修订（按修订序号升序） */
export function revisionsOfRecipe(revisions: RecipeRevision[], recipeId: string): RecipeRevision[] {
  return revisions
    .filter((item) => item.recipeId === recipeId)
    .sort((a, b) => a.revisionNo - b.revisionNo);
}

/** 某配方的当前（最新）修订 */
export function currentRevisionOf(revisions: RecipeRevision[], recipeId: string): RecipeRevision | null {
  const own = revisionsOfRecipe(revisions, recipeId);
  return own.length > 0 ? own[own.length - 1] : null;
}

/** 绑定状态 → 展示文案 */
export function bindingLabel(info: BindingInfo | null): string {
  if (!info) return '待核对';
  if (info.state === '待核对') return '待核对';
  return `v${info.revisionNo ?? '?'}`;
}
