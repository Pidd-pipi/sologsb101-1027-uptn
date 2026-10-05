/** 配方 feature selectors */
import { createFeatureSelector, createSelector } from '@ngrx/store';
import { currentRevisionOf, revisionsOfRecipe } from '../../utils/revision-binding';
import { RecipeState } from './recipe.reducer';

export const selectRecipeState = createFeatureSelector<RecipeState>('recipe');

export const selectAllRecipes = createSelector(selectRecipeState, (state) => state.recipes);
export const selectRecipeFilter = createSelector(selectRecipeState, (state) => state.filter);
export const selectSelectedRecipeId = createSelector(selectRecipeState, (state) => state.selectedId);
export const selectRecipeLoading = createSelector(selectRecipeState, (state) => state.loading);
export const selectRecipeError = createSelector(selectRecipeState, (state) => state.error);

/** 全部配方的修订快照（不可回写） */
export const selectAllRevisions = createSelector(selectRecipeState, (state) => state.revisions);

/** 某配方的全部修订快照（按修订序号升序） */
export const selectRevisionsByRecipe = (recipeId: string) =>
  createSelector(selectAllRevisions, (revisions) => revisionsOfRecipe(revisions, recipeId));

/** 某配方的当前（最新）修订快照 */
export const selectCurrentRevision = (recipeId: string) =>
  createSelector(selectAllRevisions, (revisions) => currentRevisionOf(revisions, recipeId));

/** 按 id 读取单条修订快照 */
export const selectRevisionById = (revisionId?: string) =>
  createSelector(selectAllRevisions, (revisions) => revisions.find((item) => item.id === revisionId) ?? null);

/** 某配方的当前修订序号（无修订时为 0） */
export const selectCurrentRevisionNo = (recipeId: string) =>
  createSelector(selectCurrentRevision(recipeId), (revision) => revision?.revisionNo ?? 0);

export const selectFilteredRecipes = createSelector(selectAllRecipes, selectRecipeFilter, (recipes, filter) => {
  const keyword = String(filter['keyword'] ?? '').trim().toLowerCase();
  const styles = Array.isArray(filter['styles']) ? (filter['styles'] as string[]) : [];
  return recipes.filter((recipe) => {
    const label = `${recipe.name} ${recipe.style}`.toLowerCase();
    if (keyword && !label.includes(keyword)) return false;
    if (styles.length > 0 && !styles.includes(recipe.style)) return false;
    return true;
  });
});

export const selectSelectedRecipe = createSelector(
  selectAllRecipes,
  selectSelectedRecipeId,
  (recipes, id) => recipes.find((item) => item.id === id) ?? null
);

export const selectRecipeCount = createSelector(selectAllRecipes, (recipes) => recipes.length);
