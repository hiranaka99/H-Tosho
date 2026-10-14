import type { DoujinSource, DoujinSort } from '../../lib/api';
export interface GallerySearchState { source: DoujinSource; query: string; searchKey: string | null; sort: DoujinSort }
export type GallerySearchAction = { type: 'input'; query: string } | { type: 'commit'; query: string }
  | { type: 'sort'; sort: DoujinSort } | { type: 'replace'; state: GallerySearchState };
export function gallerySearchReducer(state: GallerySearchState, action: GallerySearchAction): GallerySearchState {
  switch (action.type) {
    case 'input': return { ...state, query: action.query };
    case 'commit': return { ...state, searchKey: action.query.trim() || null };
    case 'sort': return { ...state, sort: action.sort };
    case 'replace': return action.state;
  }
}
