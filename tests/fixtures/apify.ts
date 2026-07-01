// Fixtures for Apify raw items (PRD §13). Fill in one real-shaped LinkedIn item and one tweet
// when writing the mapper tests (Layer 0, step 8). Kept minimal here to define the shape.

import type { ApifyPost, ApifyTweet } from '@/lib/types'

export const apifyLinkedInItem: ApifyPost = {
  // TODO(step 8): a realistic Apify LinkedIn post item. Must let extractActivityId derive the id
  // from linkedinUrl (NOT raw.id). See PRD §10.3.
}

export const apifyTweetItem: ApifyTweet = {
  // TODO(step 8): a realistic Apify tweet. id becomes `tweet-${id}`. See PRD §10.3.
  id: '0',
  createdAt: '1970-01-01T00:00:00.000Z',
}
