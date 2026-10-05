/**
 * RecipeService：配方及其从属数据（麦芽 / 酒花 / 糖化步 / 煮沸投加 / 发酵 / 罐装）的读写收口。
 * 全部读写走 IdbTableService → Dexie → IndexedDB。
 * 配方侧任何写操作都会经 RevisionService 产出不可回写的修订快照；
 * 发酵读数负责建立 / 巡检批次绑定，罐装登记前强制校验绑定（待核对一律拦截）。
 */
import { Injectable } from '@angular/core';
import type { Recipe } from '../models/recipe.model';
import type { Malt } from '../models/malt.model';
import type { Hop } from '../models/hop.model';
import type { MashStep } from '../models/mash-step.model';
import type { BoilAdd } from '../models/boil-add.model';
import type { Ferment } from '../models/ferment.model';
import type { Packaging } from '../models/packaging.model';
import {
  db,
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
import { RevisionService } from './revision.service';

/**
 * 配方写事务统一覆盖的表集合：RevisionService.createRevision 内部会以同一组表开事务，
 * 外层写操作必须包含全部这些表，Dexie 才会复用外层事务，保证「改动 + 快照」原子可见。
 */
const REVISION_TX_TABLES = [
  db.recipes,
  db.malts,
  db.hops,
  db.mashSteps,
  db.boilAdds,
  db.ferments,
  db.packagings,
  db.recipeRevisions,
  db.batchBindings
];

@Injectable({ providedIn: 'root' })
export class RecipeService {
  constructor(
    private readonly idb: IdbTableService,
    private readonly revisions: RevisionService
  ) {}

  /* ------------------------------ 配方 ------------------------------ */

  listRecipes(): Promise<RecipeRow[]> {
    return db.recipes.toArray().then((rows) => rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')));
  }

  async createRecipe(payload: Omit<Recipe, 'id'>): Promise<string> {
    const row = this.idb.buildRow(payload, 'recipe') as RecipeRow;
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
      await db.recipes.put(row);
      await this.revisions.createInitialRevision(row.id);
    });
    return row.id;
  }

  /** 配方头修改：写活表 + 追加修订快照（目标值无实际变化时不产生空修订） */
  updateRecipe(id: string, patch: Partial<Recipe>, note?: string): Promise<void> {
    return this.revisions.reviseRecipeHeader(id, patch, note);
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
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
        await db.malts.put(row);
        await this.revisions.createRevision(payload.recipeId, '麦芽投料调整：新增麦芽行');
      }
    );
    return row.id;
  }

  async updateMalt(id: string, patch: Partial<Malt>): Promise<void> {
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
      const before = await db.malts.get(id);
      await db.malts.update(id, { ...patch, updatedAt: Date.now() } as never);
      // 跨配方拖动麦芽行时，新旧两个配方都要出新修订
      const affected = new Set<string>([before?.recipeId, patch.recipeId].filter((v): v is string => Boolean(v)));
      for (const recipeId of affected) {
        await this.revisions.createRevision(recipeId, '麦芽投料调整：修改麦芽行');
      }
    });
  }

  async deleteMalt(id: string): Promise<void> {
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
      const before = await db.malts.get(id);
      await db.malts.delete(id);
      if (before?.recipeId) await this.revisions.createRevision(before.recipeId, '麦芽投料调整：删除麦芽行');
    });
  }

  /* ------------------------------ 酒花 ------------------------------ */

  listHops(): Promise<HopRow[]> {
    return db.hops.toArray();
  }

  async createHop(payload: Omit<Hop, 'id'>): Promise<string> {
    const row = { ...payload, id: createId('hop'), revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() };
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
        await db.hops.put(row);
        await this.revisions.createRevision(payload.recipeId, '酒花投料调整：新增酒花行');
      }
    );
    return row.id;
  }

  async updateHop(id: string, patch: Partial<Hop>): Promise<void> {
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
      const before = await db.hops.get(id);
      await db.hops.update(id, { ...patch, updatedAt: Date.now() } as never);
      const affected = new Set<string>([before?.recipeId, patch.recipeId].filter((v): v is string => Boolean(v)));
      for (const recipeId of affected) {
        await this.revisions.createRevision(recipeId, '酒花投料调整：修改酒花行');
      }
    });
  }

  async deleteHop(id: string): Promise<void> {
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
      const before = await db.hops.get(id);
      await db.hops.delete(id);
      if (before?.recipeId) await this.revisions.createRevision(before.recipeId, '酒花投料调整：删除酒花行');
    });
  }

  /* ----------------------------- 糖化步 ----------------------------- */

  listMashSteps(): Promise<MashStepRow[]> {
    return db.mashSteps.toArray().then((rows) => rows.sort((a, b) => a.seq - b.seq));
  }

  async createMashStep(payload: Omit<MashStep, 'id' | 'seq'>): Promise<string> {
    let id = '';
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
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
        id = row.id;
        await this.revisions.createRevision(payload.recipeId, '糖化步调整：新增升温步');
      }
    );
    return id;
  }

  async updateMashStep(id: string, patch: Partial<MashStep>): Promise<void> {
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
      const before = await db.mashSteps.get(id);
      await db.mashSteps.update(id, { ...patch, updatedAt: Date.now() } as never);
      const affected = new Set<string>([before?.recipeId, patch.recipeId].filter((v): v is string => Boolean(v)));
      for (const recipeId of affected) {
        await this.revisions.createRevision(recipeId, '糖化步调整：修改升温步');
      }
    });
  }

  async deleteMashStep(id: string): Promise<void> {
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
      const before = await db.mashSteps.get(id);
      await db.mashSteps.delete(id);
      if (before?.recipeId) await this.revisions.createRevision(before.recipeId, '糖化步调整：删除升温步');
    });
  }

  /** 拖拽调序后按新顺序批量写回 seq，并对该配方出新修订 */
  async reorderMashSteps(orderedIds: string[]): Promise<void> {
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
        let recipeId = '';
        for (let index = 0; index < orderedIds.length; index += 1) {
          await db.mashSteps.update(orderedIds[index], { seq: index + 1, updatedAt: Date.now() } as never);
          if (!recipeId) {
            recipeId = (await db.mashSteps.get(orderedIds[index]))?.recipeId ?? '';
          }
        }
        if (recipeId) await this.revisions.createRevision(recipeId, '糖化步调整：拖拽重排升温步顺序');
      }
    );
  }

  /* ---------------------------- 煮沸投加 ---------------------------- */

  listBoilAdds(): Promise<BoilAddRow[]> {
    return db.boilAdds.toArray();
  }

  async createBoilAdd(payload: Omit<BoilAdd, 'id'>): Promise<string> {
    const row = { ...payload, id: createId('boil'), revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() };
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
        await db.boilAdds.put(row);
        await this.revisions.createRevision(payload.recipeId, '煮沸投加调整：新增投加行');
      }
    );
    return row.id;
  }

  async updateBoilAdd(id: string, patch: Partial<BoilAdd>): Promise<void> {
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
      const before = await db.boilAdds.get(id);
      await db.boilAdds.update(id, { ...patch, updatedAt: Date.now() } as never);
      const affected = new Set<string>([before?.recipeId, patch.recipeId].filter((v): v is string => Boolean(v)));
      for (const recipeId of affected) {
        await this.revisions.createRevision(recipeId, '煮沸投加调整：修改投加行');
      }
    });
  }

  async deleteBoilAdd(id: string): Promise<void> {
    await db.transaction('rw', REVISION_TX_TABLES, async () => {
      const before = await db.boilAdds.get(id);
      await db.boilAdds.delete(id);
      if (before?.recipeId) await this.revisions.createRevision(before.recipeId, '煮沸投加调整：删除投加行');
    });
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
    // 新批次自动绑定所选配方的最新修订；已有批次读到其它配方读数会被标记为混批待核对
    await this.revisions.ensureBindingForBatch(payload.batchNo, payload.recipeId);
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
    // 罐装闸门：绑定缺失 / 待核对 / 快照丢失 / 配方不一致一律不允许罐装
    await this.revisions.assertPackagable(payload.batchNo, payload.recipeId);
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
