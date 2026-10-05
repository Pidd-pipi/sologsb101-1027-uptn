/**
 * RecipeService：配方及其从属数据（麦芽 / 酒花 / 糖化步 / 煮沸投加 / 发酵 / 罐装）的读写收口。
 * 全部读写走 IdbTableService → Dexie → IndexedDB。
 *
 * 关键约束：配方或其从属数据的任何增删改，都会在同一操作后提交一条不可回写的修订快照
 * （commitRecipeRevision）。进行中的发酵 / 罐装批次通过 revisionId 绑定到具体修订，
 * 因此配方后续改动不会重算旧批次。
 */
import { Injectable, inject } from '@angular/core';
import type { Recipe } from '../models/recipe.model';
import type { Malt } from '../models/malt.model';
import type { Hop } from '../models/hop.model';
import type { MashStep } from '../models/mash-step.model';
import type { BoilAdd } from '../models/boil-add.model';
import type { Ferment } from '../models/ferment.model';
import type { Packaging } from '../models/packaging.model';
import {
  db,
  commitRecipeRevision,
  removeRecipe,
  ROW_REVISION,
  type BoilAddRow,
  type FermentRow,
  type HopRow,
  type MaltRow,
  type MashStepRow,
  type PackagingRow,
  type RecipeRow
} from '../utils/db';
import { createId } from '../utils/uuid';
import { IdbTableService } from './idb-table.service';

@Injectable({ providedIn: 'root' })
export class RecipeService {
  private readonly idb = inject(IdbTableService);

  /* ------------------------------ 配方 ------------------------------ */

  listRecipes(): Promise<RecipeRow[]> {
    return db.recipes.toArray().then((rows) => rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')));
  }

  async createRecipe(payload: Omit<Recipe, 'id'>): Promise<string> {
    const row = this.idb.buildRow(payload, 'recipe') as RecipeRow;
    await db.recipes.put(row);
    // 新建配方即提交初始修订快照
    await commitRecipeRevision(row.id);
    return row.id;
  }

  async updateRecipe(id: string, patch: Partial<Recipe>): Promise<void> {
    await this.idb.update(db.recipes, id, patch);
    // 配方目标值改动 → 提交新修订，旧批次仍绑定原修订
    await commitRecipeRevision(id, '更新配方目标');
  }

  deleteRecipe(id: string): Promise<void> {
    return removeRecipe(id);
  }

  /* ------------------------------ 麦芽 ------------------------------ */

  listMalts(): Promise<MaltRow[]> {
    return db.malts.toArray();
  }

  async createMalt(payload: Omit<Malt, 'id'>): Promise<string> {
    const row = { ...payload, id: createId('malt'), revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() };
    await db.malts.put(row);
    await commitRecipeRevision(payload.recipeId, '新增麦芽');
    return row.id;
  }

  async updateMalt(id: string, patch: Partial<Malt>): Promise<void> {
    const existing = await db.malts.get(id);
    await this.idb.update(db.malts, id, patch);
    if (existing) await commitRecipeRevision(existing.recipeId, '调整麦芽');
  }

  async deleteMalt(id: string): Promise<void> {
    const existing = await db.malts.get(id);
    await this.idb.remove(db.malts, id);
    if (existing) await commitRecipeRevision(existing.recipeId, '删除麦芽');
  }

  /* ------------------------------ 酒花 ------------------------------ */

  listHops(): Promise<HopRow[]> {
    return db.hops.toArray();
  }

  async createHop(payload: Omit<Hop, 'id'>): Promise<string> {
    const row = { ...payload, id: createId('hop'), revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() };
    await db.hops.put(row);
    await commitRecipeRevision(payload.recipeId, '新增酒花');
    return row.id;
  }

  async updateHop(id: string, patch: Partial<Hop>): Promise<void> {
    const existing = await db.hops.get(id);
    await this.idb.update(db.hops, id, patch);
    if (existing) await commitRecipeRevision(existing.recipeId, '调整酒花');
  }

  async deleteHop(id: string): Promise<void> {
    const existing = await db.hops.get(id);
    await this.idb.remove(db.hops, id);
    if (existing) await commitRecipeRevision(existing.recipeId, '删除酒花');
  }

  /* ----------------------------- 糖化步 ----------------------------- */

  listMashSteps(): Promise<MashStepRow[]> {
    return db.mashSteps.toArray().then((rows) => rows.sort((a, b) => a.seq - b.seq));
  }

  async createMashStep(payload: Omit<MashStep, 'id' | 'seq'>): Promise<string> {
    const existing = await db.mashSteps.where('recipeId').equals(payload.recipeId).toArray();
    const seq = existing.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
    const row = {
      ...payload,
      seq,
      id: createId('mash'),
      revision: ROW_REVISION,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await db.mashSteps.put(row);
    await commitRecipeRevision(payload.recipeId, '新增糖化步');
    return row.id;
  }

  async updateMashStep(id: string, patch: Partial<MashStep>): Promise<void> {
    const existing = await db.mashSteps.get(id);
    await this.idb.update(db.mashSteps, id, patch);
    if (existing) await commitRecipeRevision(existing.recipeId, '调整糖化步');
  }

  async deleteMashStep(id: string): Promise<void> {
    const existing = await db.mashSteps.get(id);
    await this.idb.remove(db.mashSteps, id);
    if (existing) await commitRecipeRevision(existing.recipeId, '删除糖化步');
  }

  /** 拖拽调序后按新顺序批量写回 seq，并提交修订 */
  async reorderMashSteps(orderedIds: string[]): Promise<void> {
    await db.transaction('rw', [db.mashSteps], async () => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await db.mashSteps.update(orderedIds[index], { seq: index + 1, updatedAt: Date.now() } as never);
      }
    });
    const first = await db.mashSteps.get(orderedIds[0]);
    if (first) await commitRecipeRevision(first.recipeId, '糖化步调序');
  }

  /* ---------------------------- 煮沸投加 ---------------------------- */

  listBoilAdds(): Promise<BoilAddRow[]> {
    return db.boilAdds.toArray();
  }

  async createBoilAdd(payload: Omit<BoilAdd, 'id'>): Promise<string> {
    const row = { ...payload, id: createId('boil'), revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() };
    await db.boilAdds.put(row);
    await commitRecipeRevision(payload.recipeId, '新增煮沸投加');
    return row.id;
  }

  async updateBoilAdd(id: string, patch: Partial<BoilAdd>): Promise<void> {
    const existing = await db.boilAdds.get(id);
    await this.idb.update(db.boilAdds, id, patch);
    if (existing) await commitRecipeRevision(existing.recipeId, '调整煮沸投加');
  }

  async deleteBoilAdd(id: string): Promise<void> {
    const existing = await db.boilAdds.get(id);
    await this.idb.remove(db.boilAdds, id);
    if (existing) await commitRecipeRevision(existing.recipeId, '删除煮沸投加');
  }

  /* ---------------------------- 发酵读数 ---------------------------- */

  listFerments(): Promise<FermentRow[]> {
    return db.ferments.toArray().then((rows) => rows.sort((a, b) => a.date.localeCompare(b.date)));
  }

  async createFerment(payload: Omit<Ferment, 'id'>): Promise<string> {
    const row = {
      ...payload,
      id: createId('ferment'),
      revision: ROW_REVISION,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await db.ferments.put(row);
    return row.id;
  }

  updateFerment(id: string, patch: Partial<Ferment>): Promise<void> {
    return this.idb.update(db.ferments, id, patch);
  }

  deleteFerment(id: string): Promise<void> {
    return this.idb.remove(db.ferments, id);
  }

  /* ---------------------------- 罐装批次 ---------------------------- */

  listPackagings(): Promise<PackagingRow[]> {
    return db.packagings.toArray().then((rows) => rows.sort((a, b) => b.packDate.localeCompare(a.packDate)));
  }

  async createPackaging(payload: Omit<Packaging, 'id'>): Promise<string> {
    const row = {
      ...payload,
      id: createId('packaging'),
      revision: ROW_REVISION,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await db.packagings.put(row);
    return row.id;
  }

  updatePackaging(id: string, patch: Partial<Packaging>): Promise<void> {
    return this.idb.update(db.packagings, id, patch);
  }

  deletePackaging(id: string): Promise<void> {
    return this.idb.remove(db.packagings, id);
  }
}
