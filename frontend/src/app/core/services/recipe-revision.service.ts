/**
 * RecipeRevisionService：配方修订快照的读写收口。
 * - 提交修订（冻结当前配方目标值与麦芽 / 酒花 / 糖化步 / 煮沸投加）
 * - 批次绑定 / 改绑（发酵读数、罐装批次）
 * - 待核对批次的补齐绑定
 * 页面不直接触碰 Dexie，全部走本服务 → db。
 */
import { Injectable } from '@angular/core';
import {
  commitRecipeRevision,
  db,
  getRevision,
  listRevisions,
  listRevisionsByRecipe,
  type RecipeRevisionRow
} from '../utils/db';
import { resolveBinding, type BindingInfo } from '../utils/revision-binding';

export type { BindingInfo } from '../utils/revision-binding';

@Injectable({ providedIn: 'root' })
export class RecipeRevisionService {
  /** 全部修订快照 */
  listRevisions(): Promise<RecipeRevisionRow[]> {
    return listRevisions();
  }

  /** 某配方的全部修订快照（按修订序号升序） */
  listByRecipe(recipeId: string): Promise<RecipeRevisionRow[]> {
    return listRevisionsByRecipe(recipeId);
  }

  /** 读取单条修订快照 */
  get(id: string): Promise<RecipeRevisionRow | undefined> {
    return getRevision(id);
  }

  /** 配方当前（最新）修订快照 */
  async current(recipeId: string): Promise<RecipeRevisionRow | undefined> {
    const recipe = await db.recipes.get(recipeId);
    if (!recipe?.currentRevisionId) return undefined;
    return getRevision(recipe.currentRevisionId);
  }

  /** 提交一条新修订快照 */
  commit(recipeId: string, note = ''): Promise<RecipeRevisionRow> {
    return commitRecipeRevision(recipeId, note);
  }

  /**
   * 描述一条批次行（发酵 / 罐装）的绑定状态。
   * 绑定的修订快照存在且归属该配方 → 已绑定；否则待核对。
   */
  async describeBinding(row: { recipeId: string; revisionId?: string }): Promise<BindingInfo> {
    const revisions = await listRevisions();
    return resolveBinding(row, revisions);
  }

  /** 发酵批次改绑到指定修订（需页面先让用户重新确认） */
  async adoptFermentRevision(fermentId: string, revisionId: string): Promise<void> {
    const revision = await getRevision(revisionId);
    if (!revision) throw new Error('修订快照不存在，无法改绑');
    await db.ferments.update(fermentId, { revisionId, updatedAt: Date.now() });
  }

  /** 罐装批次改绑到指定修订 */
  async adoptPackagingRevision(packagingId: string, revisionId: string): Promise<void> {
    const revision = await getRevision(revisionId);
    if (!revision) throw new Error('修订快照不存在，无法改绑');
    await db.packagings.update(packagingId, { revisionId, updatedAt: Date.now() });
  }

  /**
   * 补齐发酵批次绑定：解析到配方当前修订则写回并返回 true；
   * 配方缺失（孤儿批次）或没有任何修订则无法补齐，返回 false（保持待核对）。
   */
  async backfillFermentBinding(fermentId: string): Promise<boolean> {
    const row = await db.ferments.get(fermentId);
    if (!row) return false;
    const current = await this.current(row.recipeId);
    if (!current) return false;
    await db.ferments.update(fermentId, { revisionId: current.id, updatedAt: Date.now() });
    return true;
  }

  /** 补齐罐装批次绑定，规则同 backfillFermentBinding */
  async backfillPackagingBinding(packagingId: string): Promise<boolean> {
    const row = await db.packagings.get(packagingId);
    if (!row) return false;
    const current = await this.current(row.recipeId);
    if (!current) return false;
    await db.packagings.update(packagingId, { revisionId: current.id, updatedAt: Date.now() });
    return true;
  }
}
