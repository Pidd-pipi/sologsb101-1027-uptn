/** 发酵读数 feature selectors */
import { createFeatureSelector, createSelector } from '@ngrx/store';
import { GravityTrendService } from '../../services/gravity-trend.service';
import { selectAllRevisions } from '../recipe/recipe.selectors';
import { currentRevisionOf, resolveBinding } from '../../utils/revision-binding';
import { FermentState } from './ferment.reducer';

export const selectFermentState = createFeatureSelector<FermentState>('ferment');

export const selectAllFerments = createSelector(selectFermentState, (state) => state.ferments);
export const selectFermentFilter = createSelector(selectFermentState, (state) => state.filter);
export const selectSelectedBatchNo = createSelector(selectFermentState, (state) => state.batchNo);
export const selectFermentError = createSelector(selectFermentState, (state) => state.error);

/** 全部批次号（去重） */
export const selectBatchNumbers = createSelector(selectAllFerments, (ferments) =>
  Array.from(new Set(ferments.map((item) => item.batchNo))).sort()
);

/** 当前选中批次的读数（按日期升序） */
export const selectCurrentBatchFerments = createSelector(
  selectAllFerments,
  selectSelectedBatchNo,
  (ferments, batchNo) =>
    ferments.filter((item) => item.batchNo === batchNo).sort((a, b) => a.date.localeCompare(b.date))
);

/** 当前批次绑定的配方修订快照（取首条读数的 revisionId；缺失时回退到配方当前修订） */
export const selectCurrentBatchRevision = createSelector(
  selectCurrentBatchFerments,
  selectAllRevisions,
  (ferments, revisions) => {
    const first = ferments[0];
    if (!first) return null;
    if (first.revisionId) {
      const bound = revisions.find((item) => item.id === first.revisionId);
      if (bound) return bound;
    }
    return currentRevisionOf(revisions, first.recipeId);
  }
);

/** 当前批次的绑定状态 */
export const selectCurrentBatchBinding = createSelector(
  selectCurrentBatchFerments,
  selectAllRevisions,
  (ferments, revisions) => {
    const first = ferments[0];
    return first ? resolveBinding(first, revisions) : null;
  }
);

/** 按筛选条件过滤后的读数 */
export const selectFilteredFerments = createSelector(
  selectAllFerments,
  selectFermentFilter,
  (ferments, filter) => {
    const keyword = String(filter['keyword'] ?? '').trim().toLowerCase();
    const states = Array.isArray(filter['states']) ? (filter['states'] as string[]) : [];
    return ferments.filter((item) => {
      const label = `${item.batchNo} ${item.state} ${item.date}`.toLowerCase();
      if (keyword && !label.includes(keyword)) return false;
      if (states.length > 0 && !states.includes(item.state)) return false;
      return true;
    });
  }
);

/** 当前批次的派生指标（表观发酵度 / 收得率 / 复调提示）——按绑定修订的目标值计算，配方改动不重算旧批次 */
export const selectCurrentBatchMetrics = createSelector(
  selectCurrentBatchFerments,
  selectCurrentBatchRevision,
  (ferments, revision) => GravityTrendService.calculate(ferments, revision ? revision.recipe : null)
);

/** 按 id 解析单条发酵读数的绑定状态 */
export const selectFermentBinding = (fermentId: string) =>
  createSelector(selectAllFerments, selectAllRevisions, (ferments, revisions) => {
    const row = ferments.find((item) => item.id === fermentId);
    return row ? resolveBinding(row, revisions) : null;
  });

/** 全部待核对（补不齐修订快照）的发酵读数 */
export const selectPendingFerments = createSelector(selectAllFerments, selectAllRevisions, (ferments, revisions) =>
  ferments.filter((item) => resolveBinding(item, revisions).state === '待核对')
);

/** 各配方当前被多少发酵读数绑定（影响范围统计用） */
export const selectFermentCountByRevision = createSelector(selectAllFerments, (ferments) => {
  const counts: Record<string, number> = {};
  for (const item of ferments) {
    const key = item.revisionId ?? '__pending__';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
});
