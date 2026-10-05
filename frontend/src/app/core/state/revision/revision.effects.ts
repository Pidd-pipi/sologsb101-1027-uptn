/**
 * 配方修订与批次绑定 feature effects。
 * - reconcile：每次配方域重载前先跑旧数据巡检（补齐快照 / 绑定），再回读；
 * - commitRecipe：保存配方头并产出不可回写的修订快照，完成后触发全量重载；
 * - rebindBatch：批次人工重新确认到指定修订，完成后重新巡检 + 重载。
 */
import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { catchError, exhaustMap, forkJoin, from, map, of, switchMap } from 'rxjs';
import { RecipeActions } from '../recipe/recipe.actions';
import { RecipeService } from '../../services/recipe.service';
import { RevisionService } from '../../services/revision.service';
import { RevisionActions } from './revision.actions';

@Injectable()
export class RevisionEffects {
  private readonly actions$ = inject(Actions);
  private readonly service = inject(RecipeService);
  private readonly revisions = inject(RevisionService);

  private loadRevisionData() {
    return forkJoin({
      revisions: from(this.revisions.listRevisions()),
      bindings: from(this.revisions.listBindings())
    });
  }

  /** 巡检补齐 → 回读修订与绑定 */
  reconcile$ = createEffect(() =>
    this.actions$.pipe(
      ofType(RevisionActions.reconcile),
      exhaustMap(() =>
        from(this.revisions.reconcile())
          .pipe(switchMap(() => this.loadRevisionData()))
          .pipe(
            switchMap((data) => [RevisionActions.loadRevisionsSuccess({ revisions: data.revisions, bindings: data.bindings })]),
            catchError((error: unknown) =>
              of(RevisionActions.loadFailure({ error: error instanceof Error ? error.message : '修订巡检失败' }))
            )
          )
      )
    )
  );

  /** 直接回读 */
  load$ = createEffect(() =>
    this.actions$.pipe(
      ofType(RevisionActions.loadRevisions),
      switchMap(() =>
        this.loadRevisionData().pipe(
          switchMap((data) => [RevisionActions.loadRevisionsSuccess({ revisions: data.revisions, bindings: data.bindings })]),
          catchError((error: unknown) =>
            of(RevisionActions.loadFailure({ error: error instanceof Error ? error.message : '修订数据读取失败' }))
          )
        )
      )
    )
  );

  /** 保存配方头（目标值等）并追加修订快照，成功后触发全量重载（含巡检） */
  commitRecipe$ = createEffect(() =>
    this.actions$.pipe(
      ofType(RevisionActions.commitRecipe),
      exhaustMap((action) =>
        from(this.service.updateRecipe(action.id, action.patch, action.note)).pipe(
          map(() => RecipeActions.reloadAll()),
          catchError((error: unknown) =>
            of(RevisionActions.loadFailure({ error: error instanceof Error ? error.message : '配方修订保存失败' }))
          )
        )
      )
    )
  );

  /** 批次重新确认绑定 → 走统一的 reloadAll（内含巡检 + 全量回读），并刷新发酵 / 罐装 */
  rebindBatch$ = createEffect(() =>
    this.actions$.pipe(
      ofType(RevisionActions.rebindBatch),
      exhaustMap((action) =>
        from(this.revisions.rebindBatch(action.batchNo, action.recipeId, action.revisionId)).pipe(
          map(() => RecipeActions.reloadAll()),
          catchError((error: unknown) =>
            of(RevisionActions.loadFailure({ error: error instanceof Error ? error.message : '批次重新确认失败' }))
          )
        )
      )
    )
  );
}
