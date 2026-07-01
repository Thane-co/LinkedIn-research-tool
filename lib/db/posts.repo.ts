// Layer 2 — post queries (PRD §12 step 13). All SQL for posts lives here (no inline SQL elsewhere).
// TDD against :memory: db with seeded rows: filters, pagination/hasMore, ordering, x-factor update,
// dedup queries, clustering candidate load (<=400).

import type { PostRow, PostWithMedia, SortMode, Timeframe } from '@/lib/types'

export interface PostFilters {
  platform?: 'linkedin' | 'twitter' | 'all'
  keywords?: string[]
  authors?: string[]
  minLikes?: number
  minShares?: number
  minXFactor?: number
  timeframe?: Timeframe
  dateFrom?: string
  dateTo?: string
  sort?: SortMode
  page?: number
  pageSize?: number
}

export function insertPosts(_posts: PostRow[]): { inserted: number } {
  throw new Error('Not implemented — see PRD §10.4/§12 step 13')
}

export function findExistingIds(_ids: string[]): Set<string> {
  throw new Error('Not implemented — see PRD §10.4')
}

export function findExistingUrls(_urls: string[]): Set<string> {
  throw new Error('Not implemented — see PRD §10.4')
}

export function searchPosts(
  _filters: PostFilters,
): { posts: PostRow[]; total: number; page: number; pageSize: number; hasMore: boolean } {
  throw new Error('Not implemented — see PRD §11.1')
}

export function getCandidatesForClustering(
  _filters: PostFilters,
  _requireImageEmbedding: boolean,
): PostWithMedia[] {
  throw new Error('Not implemented — see PRD §9/§11.1 (cap 400)')
}

export function getAuthorHistory(_authorId: string): PostRow[] {
  throw new Error('Not implemented — see PRD §8.4')
}

export function updateXFactor(
  _id: string,
  _values: { weighted_score: number; creator_baseline: number | null; x_factor: number | null },
): void {
  throw new Error('Not implemented — see PRD §8.4')
}

export function getUnembedded(_limit: number): PostRow[] {
  throw new Error('Not implemented — see PRD §7.3')
}

export function setEmbedding(
  _id: string,
  _embedding: Buffer,
  _embeddedAt: string,
  _imageEmbedding?: Buffer | null,
  _imageDescription?: string | null,
): void {
  throw new Error('Not implemented — see PRD §7.3')
}
