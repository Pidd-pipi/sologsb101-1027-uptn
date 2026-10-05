/** 配方修订与批次绑定 feature selectors */
import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { Recipe } from '../../models/recipe.model';
import { RevisionState } from './revision.reducer';

export const selectRevisionState = createFeatureSelector<RevisionState>('revision');

export const selectAllRevisions = createSelector(selectRevisionState, (state) => state.revisions);
export const selectAllBindings = createSelector(selectRevisionState, (state) => state.bindings);
export const selectRevisionLoading = createSelector(selectRevisionState, (state) => state.loading);
export const selectRevisionError = createSelector(selectRevisionState, (state) => state.error);

/** 待核对的批次绑定（含批次号为空的孤儿记录提醒） */
export const selectPendingBindings = createSelector(selectAllBindings, (bindings) =>
  bindings.filter((item) => item.status === '待核对')
);

/** 某配方的全部修订（修订号倒序） */
export const selectRevisionsByRecipe = (recipeId: string) =>
  createSelector(selectAllRevisions, (revisions) =>
    revisions
      .filter((item) => item.recipeId === recipeId)
      .sort((a, b) => b.revisionNo - a.revisionNo)
  );

export const selectRevisionById = (revisionId: string) =>
  createSelector(selectAllRevisions, (revisions) => revisions.find((item) => item.id === revisionId) ?? null);

/** 某配方的最新修订 */
export const selectLatestRevisionByRecipe = (recipeId: string) =>
  createSelector(selectRevisionsByRecipe(recipeId), (list) => list[0] ?? null);

/** 某配方的最新修订号（无修订返回 0） */
export const selectLatestRevisionNoByRecipe = (recipeId: string) =>
  createSelector(selectLatestRevisionByRecipe(recipeId), (latest) => latest?.revisionNo ?? 0);

export const selectBindingByBatch = (batchNo: string) =>
  createSelector(selectAllBindings, (bindings) => bindings.find((item) => item.batchNo === batchNo) ?? null);

/** 批次绑定的修订快照（快照缺失返回 null） */
export const selectBoundRevisionByBatch = (batchNo: string) =>
  createSelector(selectBindingByBatch(batchNo), selectAllRevisions, (binding, revisions) =>
    binding && binding.revisionId ? revisions.find((item) => item.id === binding.revisionId) ?? null : null
  );

/** 批次绑定修订里的配方头（旧批次重算只认这里的目标值） */
export const selectBoundRecipeByBatch = (batchNo: string) =>
  createSelector(selectBoundRevisionByBatch(batchNo), (revision): Recipe | null => revision?.recipe ?? null);

/** 批次是否需要重新确认采用新配方：已绑定且落后于配方最新修订 */
export const selectBatchBehindLatest = (batchNo: string, recipeId: string) =>
  createSelector(
    selectBindingByBatch(batchNo),
    selectLatestRevisionByRecipe(recipeId),
    (binding, latest) =>
      Boolean(
        binding &&
          binding.status === '已绑定' &&
          latest &&
          binding.recipeId === recipeId &&
          binding.revisionNo < latest.revisionNo
      )
  );

/** 影响范围：某配方当前各批次的绑定情况 */
export interface BatchBindingView {
  batchNo: string;
  revisionNo: number;
  status: '已绑定' | '待核对';
  latestNo: number;
  behind: boolean;
  note?: string;
}

export const selectBatchBindingsByRecipe = (recipeId: string) =>
  createSelector(selectAllBindings, selectAllRevisions, (bindings, revisions): BatchBindingView[] => {
    const latestNo = revisions
      .filter((item) => item.recipeId === recipeId)
      .reduce((max, item) => Math.max(max, item.revisionNo), 0);
    return bindings
      .filter((item) => item.batchNo && item.recipeId === recipeId)
      .map((item) => ({
        batchNo: item.batchNo,
        revisionNo: item.revisionNo,
        status: item.status,
        latestNo,
        behind: item.status === '已绑定' && item.revisionNo < latestNo,
        note: item.note
      }))
      .sort((a, b) => a.batchNo.localeCompare(b.batchNo));
  });
