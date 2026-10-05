/** 罐装批次 feature selectors */
import { createFeatureSelector, createSelector } from '@ngrx/store';
import { selectAllRevisions } from '../recipe/recipe.selectors';
import { currentRevisionOf, resolveBinding } from '../../utils/revision-binding';
import { PackagingState } from './packaging.reducer';

export const selectPackagingState = createFeatureSelector<PackagingState>('packaging');

export const selectAllPackagings = createSelector(selectPackagingState, (state) => state.packagings);
export const selectPackagingFilter = createSelector(selectPackagingState, (state) => state.filter);

export const selectFilteredPackagings = createSelector(
  selectAllPackagings,
  selectPackagingFilter,
  (packagings, filter) => {
    const keyword = String(filter['keyword'] ?? '').trim().toLowerCase();
    const containers = Array.isArray(filter['containers']) ? (filter['containers'] as string[]) : [];
    return packagings
      .filter((item) => {
        const label = `${item.batchNo} ${item.container}`.toLowerCase();
        if (keyword && !label.includes(keyword)) return false;
        if (containers.length > 0 && !containers.includes(item.container)) return false;
        return true;
      })
      .sort((a, b) => b.packDate.localeCompare(a.packDate));
  }
);

/** 某配方已罐装的总数量 */
export const selectPackagedQuantityByRecipe = (recipeId: string) =>
  createSelector(selectAllPackagings, (packagings) =>
    packagings.filter((item) => item.recipeId === recipeId).reduce((sum, item) => sum + item.quantity, 0)
  );

/** 按 id 解析单条罐装批次的绑定状态 */
export const selectPackagingBinding = (packagingId: string) =>
  createSelector(selectAllPackagings, selectAllRevisions, (packagings, revisions) => {
    const row = packagings.find((item) => item.id === packagingId);
    return row ? resolveBinding(row, revisions) : null;
  });

/** 全部待核对（补不齐修订快照）的罐装批次 —— 待核对拦住罐装 */
export const selectPendingPackagings = createSelector(selectAllPackagings, selectAllRevisions, (packagings, revisions) =>
  packagings.filter((item) => resolveBinding(item, revisions).state === '待核对')
);

/** 各修订被多少罐装批次绑定（影响范围统计用） */
export const selectPackagingCountByRevision = createSelector(selectAllPackagings, (packagings) => {
  const counts: Record<string, number> = {};
  for (const item of packagings) {
    const key = item.revisionId ?? '__pending__';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
});

/** 某配方当前是否允许罐装：存在当前修订快照才允许，否则待核对拦住 */
export const selectCanPackage = (recipeId: string) =>
  createSelector(selectAllRevisions, (revisions) => currentRevisionOf(revisions, recipeId) !== null);
