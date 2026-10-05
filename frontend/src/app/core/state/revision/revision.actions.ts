/** 配方修订与批次绑定 feature 的 NgRx actions */
import { createActionGroup, emptyProps, props } from '@ngrx/store';
import type { Recipe } from '../../models/recipe.model';
import type { BatchBindingRow, RecipeRevisionRow } from '../../utils/db';

export const RevisionActions = createActionGroup({
  source: 'Revision',
  events: {
    /** 旧数据 / 旧备份巡检：补齐修订快照与批次绑定，再回读 */
    'Reconcile': emptyProps(),
    'Load Revisions': emptyProps(),
    'Load Revisions Success': props<{ revisions: RecipeRevisionRow[]; bindings: BatchBindingRow[] }>(),
    'Load Failure': props<{ error: string }>(),
    /** 保存配方头并产出修订快照（note 可空，由服务生成变更摘要） */
    'Commit Recipe': props<{ id: string; patch: Partial<Recipe>; note?: string }>(),
    /** 批次重新确认：绑定到指定配方修订 */
    'Rebind Batch': props<{ batchNo: string; recipeId: string; revisionId: string }>()
  }
});
