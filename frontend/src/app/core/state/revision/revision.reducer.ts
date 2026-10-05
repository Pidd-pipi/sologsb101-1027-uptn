/** 配方修订与批次绑定 feature reducer */
import { createReducer, on } from '@ngrx/store';
import type { BatchBindingRow, RecipeRevisionRow } from '../../utils/db';
import { RevisionActions } from './revision.actions';

export interface RevisionState {
  revisions: RecipeRevisionRow[];
  bindings: BatchBindingRow[];
  loading: boolean;
  error: string | null;
}

export const initialRevisionState: RevisionState = {
  revisions: [],
  bindings: [],
  loading: false,
  error: null
};

export const revisionReducer = createReducer(
  initialRevisionState,
  on(RevisionActions.loadRevisions, RevisionActions.reconcile, (state) => ({
    ...state,
    loading: true,
    error: null
  })),
  on(RevisionActions.loadRevisionsSuccess, (state, { revisions, bindings }) => ({
    ...state,
    revisions,
    bindings,
    loading: false
  })),
  on(RevisionActions.loadFailure, (state, { error }) => ({ ...state, loading: false, error }))
);
