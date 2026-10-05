/** 发酵读数 feature selectors */
import { createFeatureSelector, createSelector } from '@ngrx/store';
import { GravityTrendService } from '../../services/gravity-trend.service';
import { selectAllBindings, selectAllRevisions } from '../revision/revision.selectors';
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

/**
 * 当前批次的派生指标（表观发酵度 / 收得率 / 复调提示）。
 * 关键：配方目标值取「批次绑定修订」里的快照，而不是活表配方 ——
 * 酿酒师后续改配方只会生成新修订，进行中批次仍绑定原修订，目标值不被重算。
 * 绑定缺失 / 待核对 / 快照丢失时 recipe 为 null，指标只反映读数本身（OG 取首读、FG 取末读）。
 */
export const selectCurrentBatchMetrics = createSelector(
  selectAllFerments,
  selectSelectedBatchNo,
  selectAllBindings,
  selectAllRevisions,
  (allFerments, batchNo, bindings, revisions) => {
    const rows = allFerments
      .filter((item) => item.batchNo === batchNo)
      .sort((a, b) => a.date.localeCompare(b.date));
    const binding = bindings.find((item) => item.batchNo === batchNo);
    const revision =
      binding && binding.status === '已绑定' && binding.revisionId
        ? revisions.find((item) => item.id === binding.revisionId)
        : undefined;
    return GravityTrendService.calculate(rows, revision?.recipe ?? null);
  }
);

/** 当前批次的绑定行（含状态 / 修订号 / 待核对说明） */
export const selectCurrentBatchBinding = createSelector(
  selectSelectedBatchNo,
  selectAllBindings,
  (batchNo, bindings) => bindings.find((item) => item.batchNo === batchNo) ?? null
);

/** 当前批次绑定的修订快照（快照缺失返回 null） */
export const selectCurrentBatchRevision = createSelector(
  selectCurrentBatchBinding,
  selectAllRevisions,
  (binding, revisions) =>
    binding && binding.revisionId ? revisions.find((item) => item.id === binding.revisionId) ?? null : null
);
