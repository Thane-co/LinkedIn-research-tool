# Giving remote Hermes access from your Mac (Cloudflare Tunnel)

Hostinger's managed Hermes Agent has no server you control: no root, no SSH, no `systemd`, no
Docker. So the API has to run on your Mac and be reachable over the internet. A Cloudflare Tunnel
does that without opening a router port or binding anything to a public interface.

**This is the trial setup, not the permanent one.** Hermes can only reach the API while your Mac is
awake with both processes running. Close the lid and Hermes gets connection errors. Once you've
confirmed Hermes actually uses the API well, move it to a real host — see
[deploy-vps.md](deploy-vps.md).

```
YOUR MAC                                          THE INTERNET            HOSTINGER
────────                                          ────────────            ─────────
snapshot.db  ──▶  next start (READONLY_SERVER=1)
233 MB, NO keys   127.0.0.1:3100
                        │
                        └──▶ cloudflared ──────▶  https://xxx           ──▶  Hermes
                                                  .trycloudflare.com          (curl / MCP)
```

The tunnelled server reads **`snapshot.db`, not `research.db`**. The snapshot has none of your API
keys, so nothing that reaches the internet can leak them or be used to spend your Apify credits.

---

## One-time setup

`cloudflared` is already installed at `~/.local/bin/cloudflared` (that folder is on your PATH).
Check it:

```bash
cloudflared --version
```

If that ever comes back "command not found", reinstall:

```bash
curl -sL -o /tmp/cf.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz
tar xzf /tmp/cf.tgz -C /tmp && mv /tmp/cloudflared ~/.local/bin/ && chmod +x ~/.local/bin/cloudflared
```

No Cloudflare account is needed for this. Quick tunnels are anonymous.

---

## Every time you want Hermes to have access

You need **three Terminal windows** on your Mac. Each block is self-contained.

### Window 1 — build the snapshot (only when data changed)

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
cd "/Users/basia/Projects/Linkedin Tool/LinkedIn-research-tool"
npm run snapshot
```

**Save the token it prints.** That's what Hermes authenticates with. Skip this step on later runs if
you haven't scraped anything new; the existing `snapshot.db` is reused, token and all.

To keep the same token across rebuilds so Hermes needs no reconfiguration:

```bash
npm run snapshot -- --token YOUR_EXISTING_TOKEN
```

### Window 2 — serve the API

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
cd "/Users/basia/Projects/Linkedin Tool/LinkedIn-research-tool"
npm run start:snapshot
```

It builds first (about a minute), then prints `✓ Ready`. Leave it running.

> The agent server builds into `.next-agent`, **not** `.next`. That matters because `npm run dev` —
> which you need in order to scrape — rewrites `.next` as a development build with no `BUILD_ID`,
> and `next start` then refuses to run. With separate directories you can scrape in the dashboard
> and serve the agent API at the same time without either breaking the other.

### Window 3 — open the tunnel

```bash
cd "/Users/basia/Projects/Linkedin Tool/LinkedIn-research-tool"
npm run tunnel
```

Among the output is a line like:

```
https://amber-workers-respected-indexes.trycloudflare.com
```

**That URL is your base address, and it changes every time you restart the tunnel.** Leave this
window running too.

### Check it before handing it to Hermes

In a fourth window (or the first one, now free):

```bash
curl -s -H "Authorization: Bearer YOUR_TOKEN" https://YOUR-TUNNEL-URL/api/v1/stats
```

You want JSON starting `{"totalPosts":84984`.

---

## Point Hermes at it

In the Hermes CLI, confirm it can reach you (`curl` is permitted there):

```
curl -s -H "Authorization: Bearer YOUR_TOKEN" https://YOUR-TUNNEL-URL/api/v1/stats
```

Then give Hermes the standing instructions. Paste this into its rules/memory, substituting your URL
and token:

```
You have read-only access to a research corpus of 84,984 scraped social posts
(LinkedIn, Twitter/X, Substack, Instagram) at:

  https://YOUR-TUNNEL-URL/api/v1

Authenticate every request with:  Authorization: Bearer YOUR_TOKEN

Call GET /api/v1 first — it returns the full endpoint and parameter reference.
Then GET /api/v1/stats to see what's in the corpus before filtering.

Key ideas:
- x_factor is how far a post beat its OWN author's 30-day baseline. x_factor: 12
  means 12x that account's normal engagement. It's a far better outlier signal
  than raw likes, which just resurface big accounts. Null for authors with fewer
  than 3 prior posts.
- ?groupByImage=true clusters by visual similarity; ?discoverTrends=true clusters
  by content. Both need embeddings, which only 6,173 posts have, and both run over
  at most 400 candidates — so filter before grouping.
- If a response has a "warnings" array, a filter you sent was not understood and
  was ignored, so results are BROADER than you asked for. Don't treat them as
  filtered.
- The base URL changes whenever the tunnel restarts. If you get connection errors,
  ask Basia for the current one.

This API is read-only. It cannot scrape, write, or reach any external service.
```

Full parameter reference: [readonly-api.md](readonly-api.md).

---

## After you scrape more data

Hermes reads `snapshot.db`, which is a point-in-time copy. New scrapes are invisible to it until you
rebuild and restart. **Leave the tunnel window alone** and the URL and token stay the same, so
Hermes needs no reconfiguration.

**The order matters.** Stop the server first: the export deletes the old snapshot file, and a
running server would hold the deleted copy open and keep serving stale data with no error.

```bash
# 1. Stop the API server (window 2): Ctrl+C, or
pkill -f "next start"

# 2. Rebuild the snapshot, reusing the SAME token
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
cd "/Users/basia/Projects/Linkedin Tool/LinkedIn-research-tool"
npm run snapshot -- --token YOUR_EXISTING_TOKEN

# 3. Start the server again (window 2)
npm run start:snapshot
```

Confirm Hermes is seeing the new data:

```bash
curl -s -H "Authorization: Bearer YOUR_TOKEN" https://YOUR-TUNNEL-URL/api/v1/stats
```

`totalPosts` and `lastScrapedAt` should both have moved.

> **Search picks up new posts immediately; grouping and clustering do not.** Those need embeddings,
> which are generated by the enrichment job that runs after a scrape (200 posts per run). If
> `enrichment.embedded` in `/api/v1/stats` hasn't moved after a scrape, enrichment isn't completing,
> and the new posts will be searchable but invisible to `groupByImage` and `discoverTrends`.

---

## Stopping it

`Ctrl+C` in windows 2 and 3, or:

```bash
pkill -f cloudflared
pkill -f "next start"
```

The moment the tunnel stops, that URL is dead and Hermes can't reach anything. That is the whole
revocation story, and it's instant.

---

## What this does and doesn't protect

**Holds up:**

- The URL is unguessable and useless without the token.
- Only `/api/v1` is served; `/api/posts`, `/api/settings` and the dashboard all return 403.
- Only GET is served; every write returns 403.
- The snapshot has no API keys, so a breach cannot spend money on your accounts.
- Nothing is bound to a public interface on your Mac and no router port is opened. `cloudflared`
  makes an outbound connection.

**Doesn't:**

- Anyone with the URL **and** token can read your whole corpus. Treat the token like a password.
- Quick-tunnel URLs are not secret. Cloudflare doesn't publish them, but don't paste it anywhere
  public.
- No rate limiting. Fine for one agent, not for exposure at large.

If you want the token to stop working, rebuild the snapshot without `--token` and restart the
server. The old token dies with the old file.

---

## Known annoyances

| Thing | Why |
| --- | --- |
| URL changes on every restart | Quick tunnels are anonymous and ephemeral. A stable hostname needs a Cloudflare account with your domain's DNS on Cloudflare, which is worth doing only if you keep this setup. |
| Hermes errors when your Mac sleeps | Expected. This is the trial arrangement's central limitation, and the reason to move to a real host if it proves useful. |
| Three windows to start | `npm run start:snapshot` and `npm run tunnel` are the only two that stay open. Snapshot building is occasional. |
