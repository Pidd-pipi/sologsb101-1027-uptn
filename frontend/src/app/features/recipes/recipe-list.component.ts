/** /recipes 配方与风格台账：维护目标 OG/FG/IBU/EBC 并显示与实绩的偏差 */
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { FilterBarComponent } from '../../shared/components/filter-bar/filter-bar.component';
import { StatBadgeComponent } from '../../shared/components/stat-badge/stat-badge.component';
import { EmptyPanelComponent } from '../../shared/components/empty-panel/empty-panel.component';
import { StyleTagComponent } from '../../shared/components/style-tag/style-tag.component';
import { BEER_STYLES, createEmptyRecipe, type Recipe } from '../../core/models/recipe.model';
import { filtersToQueryParams, queryParamsToFilters, type FilterModel, type FilterSelectConfig } from '../../core/models/filter.model';
import { RecipeActions } from '../../core/state/recipe/recipe.actions';
import { RevisionActions } from '../../core/state/revision/revision.actions';
import {
  selectFilteredRecipes,
  selectRecipeError,
  selectRecipeFilter,
  selectRecipeLoading,
  selectSelectedRecipe
} from '../../core/state/recipe/recipe.selectors';
import {
  selectAllBindings,
  selectAllRevisions,
  selectPendingBindings,
  type BatchBindingView
} from '../../core/state/revision/revision.selectors';
import { selectAllMalts } from '../../core/state/ingredients/ingredients.selectors';
import { selectAllFerments } from '../../core/state/ferment/ferment.selectors';
import { selectAllPackagings } from '../../core/state/packaging/packaging.selectors';
import { abvFromGravity, apparentAttenuation, ebcDeviation, totalGrainKg } from '../../core/utils/brew';

@Component({
  selector: 'app-recipe-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    FilterBarComponent,
    StatBadgeComponent,
    EmptyPanelComponent,
    StyleTagComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page__head">
        <div>
          <h2 class="page__title">配方与风格台账</h2>
          <p class="page__subtitle">维护目标 OG / FG / IBU / EBC，并按实际发酵读数实时回算偏差。</p>
        </div>
        <button mat-flat-button color="primary" type="button" (click)="openCreate()">
          <mat-icon>add</mat-icon>
          新建配方
        </button>
      </div>

      <div class="badge-row">
        <app-stat-badge label="配方数" [value]="recipes().length" suffix="个" tone="primary" icon="menu_book" />
        <app-stat-badge label="配方修订总数" [value]="allRevisions().length" suffix="份" tone="info" icon="history" />
        <app-stat-badge label="平均目标 IBU" [value]="avgTargetIbu()" suffix="IBU" tone="warning" icon="bolt" />
        <app-stat-badge label="平均目标 OG" [value]="avgTargetOg()" tone="info" icon="water_drop" />
        <app-stat-badge label="待核对绑定" [value]="pendingBindings().length" suffix="个" tone="danger" icon="warning" />
        <app-stat-badge label="已罐装配方" [value]="packagedRecipeCount()" suffix="个" tone="success" icon="inventory_2" />
      </div>

      @if (pendingBindings().length > 0) {
        <mat-card appearance="outlined" class="rev-banner rev-banner--warn">
          <mat-card-content>
            <strong>有 {{ pendingBindings().length }} 条批次绑定待核对</strong>
            <span class="muted">
              ：旧数据升级后存在补不齐配方修订的批次（{{ pendingBatchNos() }}），这些批次已被拦住罐装，请到发酵页逐条重新确认。
            </span>
          </mat-card-content>
        </mat-card>
      }

      <app-filter-bar
        [filters]="filter()"
        [selects]="selects"
        keywordPlaceholder="搜索配方名称 / 风格…"
        (filtersChange)="onFilterChange($event)"
        (reset)="onResetFilter()"
      ></app-filter-bar>

      @if (error()) {
        <mat-card appearance="outlined"><mat-card-content>{{ error() }}</mat-card-content></mat-card>
      }

      @if (loading()) {
        <mat-card appearance="outlined"><mat-card-content>正在读取本地配方库…</mat-card-content></mat-card>
      }

      @if (recipes().length === 0) {
        <app-empty-panel
          title="还没有匹配的配方"
          description="新建一个糖化配方，再为它配置麦芽、酒花与糖化升温步。"
          createText="新建配方"
          (create)="openCreate()"
        ></app-empty-panel>
      } @else {
        <div class="grid-cards">
          @for (recipe of recipes(); track recipe.id) {
            <mat-card appearance="outlined" [style.border-color]="recipe.id === selected()?.id ? '#3f6b3a' : null">
              <mat-card-header>
                <mat-card-title>{{ recipe.name }}</mat-card-title>
                <mat-card-subtitle>
                  <app-style-tag [value]="recipe.style"></app-style-tag>
                  <span class="rev-chip">当前 v{{ latestNo(recipe.id) }}</span>
                  <span class="muted">批次 {{ recipe.batchSizeL }} L</span>
                </mat-card-subtitle>
              </mat-card-header>
              <mat-card-content>
                <table class="data-table">
                  <tbody>
                    <tr>
                      <th>目标 OG / FG</th>
                      <td>{{ recipe.targetOg }} / {{ recipe.targetFg }}</td>
                    </tr>
                    <tr>
                      <th>目标 IBU / EBC</th>
                      <td>{{ recipe.targetIbu }} / {{ recipe.targetEbc }}</td>
                    </tr>
                    <tr>
                      <th>实绩 OG / FG</th>
                      <td>{{ realizedOg(recipe.id) }} / {{ realizedFg(recipe.id) }}</td>
                    </tr>
                    <tr>
                      <th>实绩 ABV / 发酵度</th>
                      <td>{{ realizedAbv(recipe.id) }} %vol / {{ realizedAttenuation(recipe.id) }} %</td>
                    </tr>
                    <tr>
                      <th>色度偏差</th>
                      <td [style.color]="ebcDelta(recipe) < 0 ? '#c0392b' : '#1e8449'">
                        {{ ebcDelta(recipe) > 0 ? '+' : '' }}{{ ebcDelta(recipe) }} EBC
                      </td>
                    </tr>
                    <tr>
                      <th>投料量</th>
                      <td>{{ grainKg(recipe) }} kg · 麦芽 {{ maltCount(recipe.id) }} 条</td>
                    </tr>
                    <tr>
                      <th>修订 / 影响批次</th>
                      <td>
                        <span class="muted">{{ revisionCount(recipe.id) }} 份快照 · 绑定批次 {{ impact(recipe.id).length }} 个</span>
                        @if (impact(recipe.id).length > 0) {
                          <span class="impact-line">
                            @for (view of impact(recipe.id); track view.batchNo) {
                              <span class="impact-tag" [class.impact-tag--pending]="view.status === '待核对'" [class.impact-tag--behind]="view.behind">
                                {{ view.batchNo }}·v{{ view.revisionNo || '?' }}{{ view.status === '待核对' ? '（待核对）' : view.behind ? '（落后）' : '' }}
                              </span>
                            }
                          </span>
                        }
                      </td>
                    </tr>
                  </tbody>
                </table>
                @if (revisionList(recipe.id).length > 0) {
                  <div class="rev-list">
                    <div class="rev-list__head">配方修订（不可回写）</div>
                    @for (rev of revisionList(recipe.id).slice(0, 3); track rev.id) {
                      <div class="rev-list__item">
                        <span class="rev-chip rev-chip--solid">v{{ rev.revisionNo }}</span>
                        <span class="muted">{{ rev.note }}</span>
                      </div>
                    }
                  </div>
                }
              </mat-card-content>
              <mat-card-actions align="end">
                <button mat-button type="button" (click)="select(recipe.id)">设为当前</button>
                <button mat-button type="button" (click)="edit(recipe)">改配方出新修订</button>
                <button mat-button color="warn" type="button" (click)="remove(recipe)">删除</button>
              </mat-card-actions>
            </mat-card>
          }
        </div>
      }

      @if (formVisible) {
        <mat-card appearance="outlined">
          <mat-card-header>
            <mat-card-title>{{ editingId ? '改配方（保存即生成不可回写的新修订）' : '新建配方' }}</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            @if (editingId) {
              <div class="rev-banner">
                <mat-icon inline>history</mat-icon>
                保存会基于当前目标值、麦芽、酒花、糖化步与煮沸投加生成一份新修订（当前 v{{ latestNo(editingId) }}）；
                <strong>进行中批次仍绑定原修订，不会重算</strong>，批次要采用新配方需到发酵页重新确认。
              </div>
            }
            <div class="form-grid">
              <mat-form-field appearance="outline">
                <mat-label>配方名称</mat-label>
                <input matInput [(ngModel)]="form.name" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>风格</mat-label>
                <mat-select [(ngModel)]="form.style">
                  @for (style of beerStyles; track style) {
                    <mat-option [value]="style">{{ style }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>目标 OG</mat-label>
                <input matInput type="number" step="0.001" [(ngModel)]="form.targetOg" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>目标 FG</mat-label>
                <input matInput type="number" step="0.001" [(ngModel)]="form.targetFg" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>目标 IBU</mat-label>
                <input matInput type="number" [(ngModel)]="form.targetIbu" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>目标 EBC</mat-label>
                <input matInput type="number" [(ngModel)]="form.targetEbc" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>批次体积 L</mat-label>
                <input matInput type="number" [(ngModel)]="form.batchSizeL" />
              </mat-form-field>
              @if (editingId) {
                <mat-form-field appearance="outline" class="full">
                  <mat-label>修订说明（可选，留空自动生成变更摘要）</mat-label>
                  <input matInput [(ngModel)]="revisionNote" placeholder="如：提高苦度到 65 IBU，配合新版干投酒花" />
                </mat-form-field>
              }
            </div>
          </mat-card-content>
          <mat-card-actions align="end">
            <button mat-button type="button" (click)="formVisible = false">取消</button>
            <button mat-flat-button color="primary" type="button" (click)="submit()">
              {{ editingId ? '保存并生成新修订' : '保存' }}
            </button>
          </mat-card-actions>
        </mat-card>
      }
    </div>
  `,
  styles: [
    `
      .rev-chip {
        display: inline-flex;
        align-items: center;
        padding: 1px 8px;
        margin: 0 4px;
        border-radius: 999px;
        background: #eef3ea;
        color: #3f6b3a;
        font-size: 11px;
        font-weight: 700;
      }
      .rev-chip--solid {
        background: #3f6b3a;
        color: #fff;
        margin: 0 6px 0 0;
      }
      .rev-banner {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #eef3ea;
        border-radius: 8px;
        padding: 10px 14px;
        font-size: 13px;
        color: #33402c;
      }
      .rev-banner--warn {
        background: #fdecea;
        color: #a5281b;
      }
      .impact-line {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-left: 6px;
      }
      .impact-tag {
        display: inline-block;
        padding: 1px 8px;
        border-radius: 999px;
        background: #eef3ea;
        color: #3f6b3a;
        font-size: 11px;
        font-weight: 600;
      }
      .impact-tag--behind {
        background: #fbe6c8;
        color: #7a4a12;
      }
      .impact-tag--pending {
        background: #fdecea;
        color: #a5281b;
      }
      .rev-list {
        margin-top: 10px;
        border-top: 1px dashed var(--brew-border);
        padding-top: 8px;
      }
      .rev-list__head {
        font-size: 12px;
        font-weight: 700;
        color: #3f6b3a;
        margin-bottom: 4px;
      }
      .rev-list__item {
        display: flex;
        align-items: center;
        padding: 2px 0;
      }
    `
  ]
})
export class RecipeListComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly snack = inject(MatSnackBar);

  readonly beerStyles = BEER_STYLES;
  readonly recipes = this.store.selectSignal(selectFilteredRecipes);
  readonly filter = this.store.selectSignal(selectRecipeFilter);
  readonly selected = this.store.selectSignal(selectSelectedRecipe);
  readonly loading = this.store.selectSignal(selectRecipeLoading);
  readonly error = this.store.selectSignal(selectRecipeError);

  private readonly allMalts = this.store.selectSignal(selectAllMalts);
  private readonly allFerments = this.store.selectSignal(selectAllFerments);
  private readonly allPackagings = this.store.selectSignal(selectAllPackagings);

  readonly allRevisions = this.store.selectSignal(selectAllRevisions);
  readonly allBindings = this.store.selectSignal(selectAllBindings);
  readonly pendingBindings = this.store.selectSignal(selectPendingBindings);

  formVisible = false;
  editingId: string | null = null;
  form: Omit<Recipe, 'id'> = createEmptyRecipe();
  /** 配方修改时的修订说明（可选） */
  revisionNote = '';

  readonly selects: FilterSelectConfig[] = [
    { key: 'styles', label: '风格', options: BEER_STYLES.map((style) => ({ label: style, value: style })) }
  ];

  readonly avgTargetIbu = computed(() => {
    const list = this.recipes();
    return list.length === 0 ? 0 : Math.round(list.reduce((sum, item) => sum + item.targetIbu, 0) / list.length);
  });

  readonly avgTargetOg = computed(() => {
    const list = this.recipes();
    return list.length === 0 ? 0 : Number((list.reduce((sum, item) => sum + item.targetOg, 0) / list.length).toFixed(3));
  });

  readonly packagedRecipeCount = computed(
    () => new Set(this.allPackagings().map((item) => item.recipeId)).size
  );

  /** 待核对批次号（去掉孤儿提醒的空批次号） */
  readonly pendingBatchNos = computed(() =>
    this.pendingBindings()
      .map((item) => item.batchNo)
      .filter((batchNo) => batchNo.length > 0)
      .join('、')
  );

  /** 某配方的修订列表（修订号倒序） */
  revisionList(recipeId: string) {
    return this.allRevisions()
      .filter((item) => item.recipeId === recipeId)
      .sort((a, b) => b.revisionNo - a.revisionNo);
  }

  latestNo(recipeId: string): number {
    return this.revisionList(recipeId)[0]?.revisionNo ?? 0;
  }

  revisionCount(recipeId: string): number {
    return this.revisionList(recipeId).length;
  }

  /** 某配方当前的批次绑定影响范围 */
  impact(recipeId: string): BatchBindingView[] {
    const latestNo = this.latestNo(recipeId);
    return this.allBindings()
      .filter((item) => item.batchNo && item.recipeId === recipeId)
      .map((item) => ({
        batchNo: item.batchNo,
        revisionNo: item.revisionNo,
        status: item.status,
        latestNo,
        behind: item.status === '已绑定' && item.revisionNo < latestNo,
        note: item.note
      }))
      .sort((a, b) => a.batchNo.localeCompare(b.batchNo));
  }

  ngOnInit(): void {
    this.store.dispatch(RecipeActions.reloadAll());
    this.store.dispatch(RecipeActions.selectRecipe({ id: this.route.snapshot.queryParamMap.get('recipeId') }));
    const params: Record<string, string | undefined> = {};
    this.route.snapshot.queryParamMap.keys.forEach((key) => {
      params[key] = this.route.snapshot.queryParamMap.get(key) ?? undefined;
    });
    this.store.dispatch(RecipeActions.setFilter({ filter: queryParamsToFilters(params, ['styles']) }));
  }

  /** 实际发酵首末读数 */
  private realized(recipeId: string): { og: number; fg: number } {
    const rows = this.allFerments()
      .filter((item) => item.recipeId === recipeId)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length === 0) return { og: 0, fg: 0 };
    return { og: rows[0].gravity, fg: rows[rows.length - 1].gravity };
  }

  realizedOg(recipeId: string): number {
    return this.realized(recipeId).og;
  }

  realizedFg(recipeId: string): number {
    return this.realized(recipeId).fg;
  }

  realizedAbv(recipeId: string): number {
    const { og, fg } = this.realized(recipeId);
    return abvFromGravity(og, fg);
  }

  realizedAttenuation(recipeId: string): number {
    const { og, fg } = this.realized(recipeId);
    return apparentAttenuation(og, fg);
  }

  maltCount(recipeId: string): number {
    return this.allMalts().filter((item) => item.recipeId === recipeId).length;
  }

  grainKg(recipe: Recipe): number {
    return totalGrainKg(recipe.batchSizeL, recipe.targetOg);
  }

  ebcDelta(recipe: Recipe): number {
    const malts = this.allMalts().filter((item) => item.recipeId === recipe.id);
    if (malts.length === 0) return 0;
    return ebcDeviation(malts, recipe.targetEbc);
  }

  select(id: string): void {
    this.store.dispatch(RecipeActions.selectRecipe({ id }));
  }

  openCreate(): void {
    this.editingId = null;
    this.form = createEmptyRecipe();
    this.revisionNote = '';
    this.formVisible = true;
  }

  edit(recipe: Recipe): void {
    this.editingId = recipe.id;
    this.revisionNote = '';
    this.form = {
      name: recipe.name,
      style: recipe.style,
      targetOg: recipe.targetOg,
      targetFg: recipe.targetFg,
      targetIbu: recipe.targetIbu,
      targetEbc: recipe.targetEbc,
      batchSizeL: recipe.batchSizeL
    };
    this.formVisible = true;
  }

  submit(): void {
    if (!this.form.name.trim()) {
      this.snack.open('请填写配方名称', '关闭', { duration: 2500 });
      return;
    }
    if (this.editingId) {
      // 配方改动收口为不可回写的修订快照；没有实际变化时服务端会自动跳过空修订
      this.store.dispatch(
        RevisionActions.commitRecipe({
          id: this.editingId,
          patch: { ...this.form },
          note: this.revisionNote.trim() || undefined
        })
      );
      this.snack.open('配方已保存为新修订，进行中批次仍绑定原修订', '关闭', { duration: 2800 });
    } else {
      this.store.dispatch(RecipeActions.createRecipe({ payload: { ...this.form } }));
      this.snack.open('配方已建档（v1 初始修订）', '关闭', { duration: 2200 });
    }
    this.formVisible = false;
  }

  remove(recipe: Recipe): void {
    if (!window.confirm(`删除配方「${recipe.name}」会级联删除其麦芽、酒花、糖化步、煮沸投加、发酵读数与罐装批次，是否继续？`)) {
      return;
    }
    this.store.dispatch(RecipeActions.deleteRecipe({ id: recipe.id }));
    this.snack.open('配方及其从属数据已删除', '关闭', { duration: 2500 });
  }

  onFilterChange(next: FilterModel): void {
    this.store.dispatch(RecipeActions.setFilter({ filter: next }));
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: filtersToQueryParams(next),
      replaceUrl: true
    });
  }

  onResetFilter(): void {
    this.store.dispatch(RecipeActions.resetFilter());
    void this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
  }
}
