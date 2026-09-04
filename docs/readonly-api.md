# Read-only API (`/api/v1`)

A token-gated, **read-only** HTTP API over the local research corpus, built for external agents.
It can search, filter, group, and cluster everything the dashboard can see. It **cannot** scrape,
transcribe, enrich, write, or read your API keys.

---

## 1. Setup

```bash
npm run api:token        # creates the token on first run and prints it
npm run build            # once, if you haven't built yet
npm run start:agent      # read-only instance on http://127.0.0.1:3100
```

`start:agent` runs the app with `READONLY_SERVER=1`, which does two things on that port:

1. **Refuses every non-GET request** with a 403, whatever path is asked for. The scrape, transcribe,
   settings, and ig-compare routes are all POST/PUT/DELETE, so "it cannot scrape" is a property of
   the server, not a promise about the agent's behaviour.
2. **Serves only `/api/v1`.** Everything else, including the dashboard UI and the app's own
   unauthenticated routes like `/api/posts`, returns 403. Without this the token would gate nothing,
   since `/api/posts` returns the same data with no credential at all.

Together those make the token the single door on that port, which is what makes `--rotate` and
`--revoke` actually cut off access.

You can also point an agent at your normal instance (`npm run dev`, port 3000). `/api/v1` behaves
identically there, but that port serves the whole app: its own POST routes and its unauthenticated
GET routes are reachable from any local process, so the token gates nothing there. Use `start:agent`
for anything you don't fully control.

Both instances read the same `research.db`. SQLite WAL handles the concurrent readers.

### Token management

| Command | Effect |
| --- | --- |
| `npm run api:token` | Print the token, creating one if there isn't one. |
| `npm run api:token -- --show` | Print the token and nothing else, never create. Exits 1 with a message on stderr if there is none, so a shell capture can't pick up prose. |
| `npm run api:token -- --rotate` | Replace it. An agent holding the old one is cut off from `/api/v1`, which on a `start:agent` instance is all it can reach. Combine with `--show` to print only the new token. |
| `npm run api:token -- --revoke` | Clear it. `/api/v1` returns 503 until you make a new one. |

The token lives in the local `settings` table beside your API keys. It is never in code or git, and
`GET /api/settings` masks it like every other credential.

---

## 2. Auth

Send the token as a header on every request:

```
Authorization: Bearer <token>
```

`x-api-key: <token>` also works. A `?token=` query parameter is **never** accepted, because query
strings leak into shell history, proxy logs, and referers.

| Status | Meaning |
| --- | --- |
| 401 | Missing or incorrect token. |
| 403 | You sent a write method to a read-only-mode server. |
| 404 | No post with that id. |
| 405 | You sent a write method to a `/api/v1` route. Only GET handlers exist. |
| 503 | No token is configured on the server. Run `npm run api:token`. |

---

## 3. Endpoints

Base url: `http://127.0.0.1:3100/api/v1`

| Route | What it gives you |
| --- | --- |
| `GET /` | Manifest: every endpoint, parameter, enum, and default, plus an explicit list of what this API cannot do. Point an agent here first. |
| `GET /openapi.json` | The same surface as an OpenAPI 3.1 document. |
| `GET /stats` | What is actually in the corpus: posts, authors, likes and date coverage per platform; posts per market; enrichment counts; creator count; last scrape time. |
| `GET /posts` | The search. Full filter set, paginated, or clustered. |
| `GET /posts/{id}` | One post, including its transcript when it has one. |
| `GET /authors` | Distinct authors under the current filters, with the `author_id` values to filter by. |
| `GET /creators` | The tracked creator list, with tier, tags, and cross-platform persona. |
| `GET /keywords` | Saved keyword sets, grouped by market. |
| `GET /profiles` | LinkedIn profiles scraped so far: headline, about, follower count, experience. |

### `GET /posts` parameters

**Filters** (also accepted by `/authors`)

| Param | Notes |
| --- | --- |
| `q` | Comma-separated substrings matched against post content, OR'd. Alias of `keywords`; both combine. |
| `keywords` | Same as `q`. |
| `platform` | Comma-separated subset of `linkedin,twitter,substack,instagram`. Omit for all. Unknown values are ignored. |
| `authors` | Comma-separated `author_id` values (clean slugs/handles from `/authors`). |
| `market` | Exact market bucket, e.g. `ai`. |
| `minLikes`, `minShares` | Numeric floors. |
| `minXFactor` | Floor on the overperformance multiple. Posts with no baseline yet are excluded. |
| `timeframe` | `all` (default), `24h`, `3d`, `week`, `month`, `3months`, `custom`. |
| `dateFrom`, `dateTo` | ISO timestamps. Supplying either implies `timeframe=custom`, so a date range works on its own. An explicit non-`custom` `timeframe` wins and you get a warning. |

**Paging**

| Param | Notes |
| --- | --- |
| `sort` | `recent` (default), `likes`, `xfactor`. |
| `page` | 1-based. Default 1. |
| `pageSize` | Default 50, max 200. |

**Grouping** (replaces pagination; runs over at most 400 most-liked candidates that have embeddings)

| Param | Notes |
| --- | --- |
| `groupByImage=true` | Cluster by visual similarity of the post image. Returns `imageGroups`. |
| `discoverTrends=true` | Cluster by content similarity. Returns `contentClusters`. |
| `imageThreshold` | Cosine cutoff for `groupByImage`. Default 0.80. |
| `textThreshold` | Cosine cutoff for `discoverTrends`. Default 0.65. |

### Unknown parameters and `warnings`

Filters fail open: an unrecognized `timeframe`, `sort`, or `platform`, or a non-numeric `minLikes`,
is **dropped**, not rejected. That keeps a typo from breaking the dashboard, but for an agent it
means a mistyped filter silently widens the results. So any ignored param is reported in a
`warnings` array on the response:

```jsonc
{ "posts": [ ... ], "total": 84984,
  "warnings": ["Ignored unknown timeframe='lastweek'. Expected one of: all, 24h, 3d, week, month, 3months, custom."] }
```

`warnings` is absent when everything was understood. **Treat its presence as "these results are
broader than I asked for"** rather than ignoring it.

### Response shapes

Paginated:

```jsonc
{
  "posts": [ /* serialized posts */ ],
  "total": 649, "page": 1, "pageSize": 50, "hasMore": true,
  "availableAuthors": [ { "author_id": "...", "author_name": "...", "platform": "linkedin",
                          "avatar": null, "isCore": true, "persona": "..." } ]
}
```

Grouping (`groupByImage` or `discoverTrends`):

```jsonc
{
  "posts": [ /* every candidate, so you can resolve group members by id */ ],
  "imageGroups": [ { "postIds": ["..."], "sharedDescription": "...", "similarity": 0.84,
                     "totalLikes": 16820, "totalShares": 120 } ],
  // or "contentClusters": [ { "postIds": [...], "label": "...", "similarity": 0.75, ... } ]
  "hasMore": false,
  "availableAuthors": [ ... ]
}
```

A serialized post carries `id, platform, url, content, author_name, author_url, author_id,
author_type, likes, shares, comments, posted_at, scraped_at, is_repost, scrape_source, market,
media, transcript, image_url, image_description, embedded_at, weighted_score, creator_baseline,
x_factor`. Embedding vectors and the raw scraped payload are **never** serialized.

### Reading `x_factor`

`x_factor` is how far a post beat its **own author's** recent baseline:

```
weighted_score = likes·1 + comments·3 + shares·5
x_factor       = weighted_score ÷ (that author's mean weighted_score over the prior 30 days)
```

It needs at least 3 prior posts from that author, so it is `null` on new authors. `x_factor: 14.5`
means the post did 14.5x that account's normal engagement, which is a much better outlier signal
than raw likes: it does not just resurface accounts with big followings.

---

## 4. Examples

```bash
TOKEN=$(npm run --silent api:token -- --show)
BASE=http://127.0.0.1:3100/api/v1
AUTH="Authorization: Bearer $TOKEN"

# What's in here?
curl -s -H "$AUTH" "$BASE/stats"

# Outliers: LinkedIn posts about agents that beat their author's baseline 5x, last month
curl -s -H "$AUTH" "$BASE/posts?q=agent&platform=linkedin&minXFactor=5&timeframe=month&sort=xfactor"

# What visual formats are working right now
curl -s -H "$AUTH" "$BASE/posts?groupByImage=true&platform=linkedin&minLikes=200"

# What topics are clustering
curl -s -H "$AUTH" "$BASE/posts?discoverTrends=true&timeframe=week&minLikes=100"

# One creator's best posts
curl -s -H "$AUTH" "$BASE/posts?authors=thejustinwelsh&sort=xfactor&pageSize=20"

# Who is in the corpus
curl -s -H "$AUTH" "$BASE/authors?platform=substack"
```

---

## 5. Limits worth knowing

- **Grouping only sees enriched posts.** Clustering needs embeddings, and only part of the corpus is
  embedded. `stats.enrichment` tells you how much. Enriching more requires a scrape run, which this
  API deliberately cannot trigger.
- **`q` is substring matching, not semantic search.** `content LIKE %term%`, OR'd across terms.
- **Grouping is capped at 400 candidates**, taken most-liked first, so filter before you group.
- **On the main instance (port 3000) the token gates nothing.** The app's own GET routes there are
  unauthenticated by design, so `/api/posts` returns the same data with no credential. Only a
  `start:agent` instance makes the token a real boundary. Do not expose either port to a network
  without real auth in front of it.
