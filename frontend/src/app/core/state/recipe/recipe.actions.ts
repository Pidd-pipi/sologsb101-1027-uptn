/** 配方 feature 的 NgRx actions */
import { createActionGroup, emptyProps, props } from '@ngrx/store';
import type { Recipe } from '../../models/recipe.model';
import type { FilterModel } from '../../models/filter.model';
import type { RecipeRevisionRow, RecipeRow } from '../../utils/db';

export const RecipeActions = createActionGroup({
  source: 'Recipe',
  events: {
    'Load Recipes': emptyProps(),
    'Load Recipes Success': props<{ recipes: RecipeRow[] }>(),
    'Load Revisions Success': props<{ revisions: RecipeRevisionRow[] }>(),
    'Load Failure': props<{ error: string }>(),
    'Reload All': emptyProps(),
    'Select Recipe': props<{ id: string | null }>(),
    'Set Filter': props<{ filter: FilterModel }>(),
    'Reset Filter': emptyProps(),
    'Create Recipe': props<{ payload: Omit<Recipe, 'id'> }>(),
    'Update Recipe': props<{ id: string; patch: Partial<Recipe> }>(),
    'Delete Recipe': props<{ id: string }>(),
    /** 提交一条新修订快照（配方或从属数据改动后由 effects 触发） */
    'Commit Revision': props<{ recipeId: string; note?: string }>(),
    /** 发酵批次改绑到指定修订（需页面先让用户重新确认） */
    'Adopt Ferment Revision': props<{ fermentId: string; revisionId: string }>(),
    /** 罐装批次改绑到指定修订 */
    'Adopt Packaging Revision': props<{ packagingId: string; revisionId: string }>(),
    /** 补齐发酵批次绑定（待核对 → 解析到当前修订） */
    'Backfill Ferment Binding': props<{ fermentId: string }>(),
    /** 补齐罐装批次绑定 */
    'Backfill Packaging Binding': props<{ packagingId: string }>()
  }
});
