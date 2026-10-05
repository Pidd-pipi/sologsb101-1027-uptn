/**
 * RevisionService：配方修订快照与批次绑定的领域收口。
 *
 * 不变量：
 * 1. 配方改动（目标值 / 麦芽 / 酒花 / 糖化步 / 煮沸投加）一律追加一条新的 RecipeRevision，
 *    快照内容深拷贝自当期活表，历史快照永不回写；内容与最新修订完全一致时跳过去重。
 * 2. 发酵批次（按批次号）通过 BatchBinding 绑定到某个修订；批次读数派生指标只认绑定修订的目标值，
 *    配方再怎么改都不会让旧批次重算。批次要换配方 / 换新修订必须显式 rebindBatch（重新确认）。
 * 3. reconcile() 为旧数据 / 旧备份补齐快照与绑定；补不齐（配方缺失、混批、孤儿批次）一律「待核对」，
 *    罐装前由 assertPackagable 拦截。
 */
import { Injectable } from '@angular/core';
import type { Recipe } from '../models/recipe.model';
import {
  db,
  ROW_REVISION,
  type BatchBindingRow,
  type FermentRow,
  type PackagingRow,
  type RecipeRevisionRow,
  type Revisioned
} from '../utils/db';
import { createId } from '../utils/uuid';

/** 配方头参与快照 / 比对的字段 */
const RECIPE_HEADER_KEYS: Array<keyof Recipe> = [
  'name',
  'style',
  'targetOg',
  'targetFg',
  'targetIbu',
  'targetEbc',
  'batchSizeL'
];

const RECIPE_HEADER_LABELS: Record<keyof Recipe, string> = {
  id: '编号',
  name: '名称',
  style: '风格',
  targetOg: '目标 OG',
  targetFg: '目标 FG',
  targetIbu: '目标 IBU',
  targetEbc: '目标 EBC',
  batchSizeL: '批次体积'
};

/** 配方写事务需要覆盖的全部表（createRevision 的内部事务要求整组可见，外层必须给全） */
const TX_TABLES = [
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

/** 去掉行级修订号 / 时间戳，只保留业务字段进快照 */
function toBusiness<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

/** 修订快照的可比较内容（不含 id / 序号 / 时间 / 说明） */
function revisionContent(
  rev: Pick<RecipeRevisionRow, 'recipe' | 'malts' | 'hops' | 'mashSteps' | 'boilAdds'>
): string {
  return JSON.stringify({
    recipe: rev.recipe,
    malts: [...rev.malts].sort((a, b) => a.id.localeCompare(b.id)),
    hops: [...rev.hops].sort((a, b) => a.id.localeCompare(b.id)),
    mashSteps: [...rev.mashSteps].sort((a, b) => a.seq - b.seq),
    boilAdds: [...rev.boilAdds].sort((a, b) => a.id.localeCompare(b.id))
  });
}

@Injectable({ providedIn: 'root' })
export class RevisionService {
  /* ----------------------------- 查询 ----------------------------- */

  /** 全部修订（按配方、修订号倒序） */
  async listRevisions(): Promise<RecipeRevisionRow[]> {
    const rows = await db.recipeRevisions.toArray();
    return rows.sort((a, b) =>
      a.recipeId === b.recipeId ? b.revisionNo - a.revisionNo : a.recipeId.localeCompare(b.recipeId)
    );
  }

  /** 某配方的全部修订（修订号倒序） */
  async revisionsOfRecipe(recipeId: string): Promise<RecipeRevisionRow[]> {
    const rows = await db.recipeRevisions.where('recipeId').equals(recipeId).toArray();
    return rows.sort((a, b) => b.revisionNo - a.revisionNo);
  }

  async getRevision(revisionId: string): Promise<RecipeRevisionRow | undefined> {
    return db.recipeRevisions.get(revisionId);
  }

  /** 某配方的最新修订；无修订返回 undefined（旧数据异常态） */
  async latestRevision(recipeId: string): Promise<RecipeRevisionRow | undefined> {
    const rows = await db.recipeRevisions.where('recipeId').equals(recipeId).toArray();
    return rows.sort((a, b) => b.revisionNo - a.revisionNo)[0];
  }

  async listBindings(): Promise<BatchBindingRow[]> {
    const rows = await db.batchBindings.toArray();
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async bindingForBatch(batchNo: string): Promise<BatchBindingRow | undefined> {
    if (!batchNo) return undefined;
    return db.batchBindings.where('batchNo').equals(batchNo).first();
  }

  /* --------------------------- 修订快照 --------------------------- */

  /**
   * 按当期活表为配方拍一张新修订快照（不可回写）。
   * 可在其它写事务内调用：Dexie 会复用当前事务，保证「改动 + 快照」原子落库。
   * 若快照内容与最新修订完全一致则跳过，返回最新修订，避免空修订。
   */
  async createRevision(recipeId: string, note: string): Promise<RecipeRevisionRow | null> {
    return db.transaction('rw', TX_TABLES, async (): Promise<RecipeRevisionRow | null> => {
        const recipe = await db.recipes.get(recipeId);
        if (!recipe) throw new Error('配方不存在，无法生成修订快照');
        const [malts, hops, mashSteps, boilAdds] = await Promise.all([
          db.malts.where('recipeId').equals(recipeId).toArray(),
          db.hops.where('recipeId').equals(recipeId).toArray(),
          db.mashSteps.where('recipeId').equals(recipeId).toArray(),
          db.boilAdds.where('recipeId').equals(recipeId).toArray()
        ]);

        const candidate = {
          recipeId,
          note,
          recipe: toBusiness(recipe),
          malts: malts.map(toBusiness),
          hops: hops.map(toBusiness),
          mashSteps: mashSteps.map(toBusiness).sort((a, b) => a.seq - b.seq),
          boilAdds: boilAdds.map(toBusiness)
        };

        const latest = await this.latestRevision(recipeId);
        if (latest && revisionContent(latest) === revisionContent(candidate)) {
          return latest;
        }

        const row: RecipeRevisionRow = {
          ...candidate,
          id: createId('rv'),
          revisionNo: (latest?.revisionNo ?? 0) + 1,
          createdAt: Date.now()
        };
        await db.recipeRevisions.put(row);
        return row;
      }
    );
  }

  /** 配方头（目标值等）修改：更新活表并追加修订；目标值没有实际变化时不产生修订 */
  async reviseRecipeHeader(recipeId: string, patch: Partial<Recipe>, note?: string): Promise<void> {
    await db.transaction('rw', TX_TABLES, async () => {
      const before = await db.recipes.get(recipeId);
        if (!before) throw new Error('配方不存在，无法修改');
        const changedKeys = RECIPE_HEADER_KEYS.filter(
          (key) => patch[key] !== undefined && String(patch[key]) !== String(before[key])
        );
        if (changedKeys.length === 0) return;
        await db.recipes.update(recipeId, { ...patch, updatedAt: Date.now() } as never);
        const summary = changedKeys
          .map((key) => `${RECIPE_HEADER_LABELS[key]}：${before[key]} → ${patch[key]}`)
          .join('；');
        await this.createRevision(recipeId, note?.trim() || `配方修改：${summary}`);
      }
    );
  }

  /** 新建配方后建立 v1 初始修订（此时通常还没有任何投料行） */
  async createInitialRevision(recipeId: string, note = '初始修订：配方建档'): Promise<void> {
    await this.createRevision(recipeId, note);
  }

  /* ----------------------------- 绑定 ----------------------------- */

  /**
   * 录入发酵读数时确保批次已绑定：
   * - 新批次：绑定到所选配方的最新修订；配方连修订快照都没有则「待核对」。
   * - 已绑定批次读到其它配方的读数：混批，转「待核对」，由人工重新确认。
   */
  async ensureBindingForBatch(batchNo: string, recipeId: string): Promise<void> {
    if (!batchNo || !recipeId) return;
    await db.transaction('rw', [db.recipeRevisions, db.batchBindings], async () => {
      const existing = await db.batchBindings.where('batchNo').equals(batchNo).first();
      const now = Date.now();
      if (existing) {
        if (existing.status === '已绑定' && existing.recipeId !== recipeId) {
          await db.batchBindings.update(existing.id, {
            status: '待核对',
            note: '同批次出现了其他配方的读数（疑似混批），请人工核对后重新确认',
            updatedAt: now
          } as never);
        }
        return;
      }
      const latest = await this.latestRevision(recipeId);
      const row: BatchBindingRow = {
        id: createId('bd'),
        batchNo,
        recipeId: latest ? recipeId : '',
        revisionId: latest?.id ?? '',
        revisionNo: latest?.revisionNo ?? 0,
        status: latest ? '已绑定' : '待核对',
        note: latest ? '新批次：绑定建档时的最新修订' : '配方缺少修订快照，待人工核对',
        boundAt: now,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      };
      await db.batchBindings.put(row);
    });
  }

  /** 批次重新确认：显式绑定到某配方的某条修订（通常是该配方的最新修订） */
  async rebindBatch(batchNo: string, recipeId: string, revisionId: string): Promise<void> {
    if (!batchNo) throw new Error('批次号为空，无法重新确认');
    const revision = await db.recipeRevisions.get(revisionId);
    if (!revision) throw new Error('所选修订快照不存在，无法绑定');
    if (revision.recipeId !== recipeId) throw new Error('修订与配方不匹配，无法绑定');
    const now = Date.now();
    await db.transaction('rw', [db.batchBindings], async () => {
      const existing = await db.batchBindings.where('batchNo').equals(batchNo).first();
      if (existing) {
        await db.batchBindings.update(existing.id, {
          recipeId,
          revisionId,
          revisionNo: revision.revisionNo,
          status: '已绑定',
          note: `人工重新确认：绑定 v${revision.revisionNo} 修订`,
          updatedAt: now
        } as never);
      } else {
        await db.batchBindings.put({
          id: createId('bd'),
          batchNo,
          recipeId,
          revisionId,
          revisionNo: revision.revisionNo,
          status: '已绑定',
          note: '人工核对后补绑修订',
          boundAt: now,
          revision: ROW_REVISION,
          createdAt: now,
          updatedAt: now
        });
      }
    });
  }

  /** 罐装前置校验：绑定缺失 / 待核对 / 修订快照丢失一律拦截 */
  async assertPackagable(batchNo: string, recipeId?: string): Promise<BatchBindingRow> {
    if (!batchNo) throw new Error('批次号为空，无法罐装');
    const binding = await db.batchBindings.where('batchNo').equals(batchNo).first();
    if (!binding) throw new Error(`批次「${batchNo}」缺少配方修订绑定，请先到发酵页核对后再罐装`);
    if (binding.status === '待核对') {
      throw new Error(`批次「${batchNo}」的配方修订绑定待核对，请先到发酵页重新确认后再罐装`);
    }
    if (!binding.revisionId || !(await db.recipeRevisions.get(binding.revisionId))) {
      throw new Error(`批次「${batchNo}」绑定的修订快照已缺失，请重新确认后再罐装`);
    }
    if (recipeId && binding.recipeId && recipeId !== binding.recipeId) {
      throw new Error(`批次「${batchNo}」绑定的配方与所选配方不一致，请核对后再罐装`);
    }
    return binding;
  }

  /* --------------------------- 旧数据兜底 --------------------------- */

  /**
   * 旧数据 / 旧备份升级后的补齐与巡检（幂等）：
   * - 缺修订快照的配方：按当期活表补拍 v1；
   * - 缺绑定的批次：配方唯一且有快照 → 自动绑定最新修订；否则 → 待核对；
   * - 已绑定但快照丢失，或同批次混了多个配方读数 → 待核对；
   * - 缺批次号 / 配方的孤儿记录：汇总成一条待核对提醒。
   */
  async reconcile(): Promise<void> {
    await db.transaction('rw', TX_TABLES, async () => {
      const now = Date.now();
        const recipes = await db.recipes.toArray();
        const recipeIds = new Set(recipes.map((item) => item.id));

        // 1. 缺快照的配方补拍修订
        const revisions = await db.recipeRevisions.toArray();
        const revisionRecipes = new Set(revisions.map((item) => item.recipeId));
        for (const recipeId of recipeIds) {
          if (!revisionRecipes.has(recipeId)) {
            await this.createRevision(recipeId, '旧数据补齐：按当期活表补拍的修订快照');
          }
        }

        const [ferments, packagings, latestRevisions, bindings] = await Promise.all([
          db.ferments.toArray(),
          db.packagings.toArray(),
          this.latestRevisionMap(),
          db.batchBindings.toArray()
        ]);

        // 2. 按批次号汇总出现过的配方
        const batchRecipes = new Map<string, Set<string>>();
        let orphanCount = 0;
        const collect = (rows: Array<FermentRow | PackagingRow>): void => {
          for (const row of rows) {
            if (!row.batchNo || !row.recipeId) {
              orphanCount += 1;
              continue;
            }
            const set = batchRecipes.get(row.batchNo) ?? new Set<string>();
            set.add(row.recipeId);
            batchRecipes.set(row.batchNo, set);
          }
        };
        collect(ferments);
        collect(packagings);

        const existingByBatch = new Map(
          bindings.filter((item) => item.batchNo).map((item) => [item.batchNo, item])
        );
        const pendingOrphan = bindings.find((item) => item.id === 'bd-pending-orphan');

        for (const [batchNo, recipeSet] of batchRecipes) {
          const existing = existingByBatch.get(batchNo);
          if (existing) {
            // 已绑定但快照丢失，或出现混批 → 转待核对；待核对态必须人工解除，不做自动回绑
            const revisionExists = existing.revisionId
              ? Boolean(await db.recipeRevisions.get(existing.revisionId))
              : false;
            const mixed = recipeSet.size > 1 || (existing.recipeId !== '' && !recipeSet.has(existing.recipeId));
            if (existing.status === '已绑定' && (!revisionExists || mixed)) {
              await db.batchBindings.update(existing.id, {
                status: '待核对',
                recipeId: revisionExists ? existing.recipeId : '',
                note: !revisionExists
                  ? '绑定的修订快照已丢失，请重新确认'
                  : '同批次出现多个配方的读数（疑似混批），请人工核对',
                updatedAt: now
              } as never);
            }
            continue;
          }

          if (recipeSet.size === 1) {
            const recipeId = [...recipeSet][0];
            const latest = recipeIds.has(recipeId) ? latestRevisions.get(recipeId) : undefined;
            if (latest) {
              await db.batchBindings.put(
                this.boundRow(batchNo, recipeId, latest.id, latest.revisionNo, now, '旧数据补齐：自动绑定配方最新修订')
              );
            } else {
              await db.batchBindings.put(
                this.pendingRow(`bd-pending-${batchNo}`, batchNo, now, '批次的配方缺少修订快照，请人工核对')
              );
            }
          } else {
            await db.batchBindings.put(
              this.pendingRow(`bd-pending-${batchNo}`, batchNo, now, '同批次出现多个配方的读数（疑似混批），请人工核对')
            );
          }
        }

        // 3. 孤儿记录提醒（缺批次号 / 配方的发酵或罐装行）
        if (orphanCount > 0) {
          await db.batchBindings.put(
            this.pendingRow('bd-pending-orphan', '', now, `有 ${orphanCount} 条发酵 / 罐装记录缺少批次号或配方，待人工核对`)
          );
        } else if (pendingOrphan) {
          await db.batchBindings.delete(pendingOrphan.id);
        }
      }
    );
  }

  private async latestRevisionMap(): Promise<Map<string, RecipeRevisionRow>> {
    const rows = await db.recipeRevisions.toArray();
    const map = new Map<string, RecipeRevisionRow>();
    for (const row of rows) {
      const current = map.get(row.recipeId);
      if (!current || row.revisionNo > current.revisionNo) map.set(row.recipeId, row);
    }
    return map;
  }

  private boundRow(
    batchNo: string,
    recipeId: string,
    revisionId: string,
    revisionNo: number,
    now: number,
    note: string
  ): BatchBindingRow {
    return {
      id: createId('bd'),
      batchNo,
      recipeId,
      revisionId,
      revisionNo,
      status: '已绑定',
      note,
      boundAt: now,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    };
  }

  private pendingRow(id: string, batchNo: string, now: number, note: string): BatchBindingRow {
    return {
      id,
      batchNo,
      recipeId: '',
      revisionId: '',
      revisionNo: 0,
      status: '待核对',
      note,
      boundAt: now,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    };
  }
}
