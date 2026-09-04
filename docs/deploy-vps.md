# Deploying the read-only API to your VPS

A step-by-step runbook. Hermes ends up querying the corpus over `localhost` on the VPS it already
runs on: nothing exposed to the internet, no tunnel, no dependency on your Mac being awake.

```
YOUR MAC                                    YOUR VPS
────────                                    ────────
research.db      ── npm run snapshot ──▶    snapshot.db
588 MB, has your                            233 MB, NO keys
API keys                    ▲
                            │ scp
                            │
                                            next start (READONLY_SERVER=1)
                                            listening on 127.0.0.1:3100
                                                    │
                                            Hermes ─┘  GET /api/v1/...
```

---

## How to read this

Every command block is labelled with **where to run it**:

| Label | Means |
| --- | --- |
| 🖥️ **MAC** | Your Mac's Terminal, in the `LinkedIn-research-tool` folder. |
| ☁️ **VPS** | Inside your SSH session, after you've connected in Step 2. |

Anything in `ALL_CAPS` is a placeholder **you replace**. There are only three:

| Placeholder | What it is | Where to find it |
| --- | --- | --- |
| `VPS_IP` | Your server's IP address | Hostinger hPanel → VPS → Overview |
| `VPS_USER` | Your SSH username, usually `root` | Hostinger hPanel → VPS → SSH Access |
| `REMOTE_TOKEN` | Printed by Step 1. Save it. | Step 1 output |

---

## Step 1 — Build the snapshot 🖥️ MAC

```bash
cd "/Users/basia/Projects/Linkedin Tool/LinkedIn-research-tool"
npm run snapshot
```

Takes about 5 seconds. You'll see:

```
Snapshot written to ./snapshot.db (233.5 MB), down from 588.2 MB.

  posts      84,984 rows
  profiles   259 rows
  creators   118 rows
  keywords   17 rows

  raw_data      stripped
  API keys      NOT included (settings holds only the remote token)

Remote read-only token (separate from your local one):

  a1b2c3d4...
```

**Copy that token somewhere safe now.** It is `REMOTE_TOKEN` for the rest of this guide, and it's
what Hermes will authenticate with. It's different from your local token on purpose: revoking one
never affects the other.

> If you ever need to see it again: it's inside the snapshot, not your main database. Easiest is to
> rebuild with `npm run snapshot -- --token YOUR_SAVED_TOKEN` to force a known value.

---

## Step 2 — Connect to the VPS 🖥️ MAC

```bash
ssh VPS_USER@VPS_IP
```

First time it asks `Are you sure you want to continue connecting?` — type `yes`. Then enter your
password (Hostinger emailed it, or you set it in hPanel).

You're in when the prompt changes to something like `root@srv123:~#`.

**Leave this window open.** Every ☁️ VPS command goes here. Open a *second* Terminal window for the
🖥️ MAC commands, so you don't have to keep reconnecting.

---

## Step 3 — Install Node and the build tools ☁️ VPS

The app uses `better-sqlite3`, which compiles from source, so the server needs a C toolchain.

```bash
apt-get update
apt-get install -y build-essential python3 rsync
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

Check it worked:

```bash
node -v
```

Should print `v20.x.x`. If it prints `v18` or lower, the install didn't take; re-run the two
`curl`/`apt-get install -y nodejs` lines.

> Not logged in as root? Put `sudo ` in front of each `apt-get` and `curl ... | sudo -E bash -`.

---

## Step 4 — Create the folder ☁️ VPS

```bash
mkdir -p /srv/research-api
```

---

## Step 5 — Copy the app across 🖥️ MAC

Nothing was pushed to GitHub, so this copies the code straight from your Mac. Run it from the
`LinkedIn-research-tool` folder — **the trailing `/` after `./` matters.**

```bash
cd "/Users/basia/Projects/Linkedin Tool/LinkedIn-research-tool"
rsync -av --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude coverage \
  --exclude 'research.db*' --exclude 'snapshot.db*' --exclude '.env*' \
  ./ VPS_USER@VPS_IP:/srv/research-api/
```

What each exclusion is for:

| Excluded | Why |
| --- | --- |
| `node_modules` | Contains a Mac-compiled `better-sqlite3`. The VPS builds its own in Step 6. |
| `.next` | Rebuilt on the VPS. |
| `research.db*` | Your real database, 588MB, **holds your API keys**. Must never leave your Mac. |
| `snapshot.db*` | Sent separately in Step 7 (rsync would work, but scp gives you a progress bar). |
| `.env*` | `.env.local` sets `DB_PATH=./research.db`, which would point the VPS at a database that isn't there. |

---

## Step 6 — Install and build ☁️ VPS

```bash
cd /srv/research-api
npm ci
npm run build
```

`npm ci` takes a few minutes (it compiles `better-sqlite3`). `npm run build` ends with a route list
including `/api/v1`, `/api/v1/posts`, and so on.

> **If `npm run build` fails with "JavaScript heap out of memory"**, your VPS is short on RAM. Build
> on your Mac instead and copy the result:
> ```bash
> # 🖥️ MAC
> npm run build
> rsync -av .next/ VPS_USER@VPS_IP:/srv/research-api/.next/
> ```
> The build output is plain JavaScript and is portable. `node_modules` is not, which is why Step 6's
> `npm ci` still has to run on the VPS.

---

## Step 7 — Send the snapshot 🖥️ MAC

```bash
cd "/Users/basia/Projects/Linkedin Tool/LinkedIn-research-tool"
scp snapshot.db VPS_USER@VPS_IP:/srv/research-api/snapshot.db
```

233MB, so give it a minute or two depending on your upload speed.

---

## Step 8 — Test it by hand before making it a service ☁️ VPS

Worth doing separately, so that if something's wrong you see the error directly instead of hunting
through logs.

```bash
cd /srv/research-api
DB_PATH=/srv/research-api/snapshot.db READONLY_SERVER=1 npx next start -H 127.0.0.1 -p 3100
```

You should see `✓ Ready in ...`. Leave it running, open a **third** Terminal, SSH in again, and:

```bash
curl -s -H "Authorization: Bearer REMOTE_TOKEN" http://127.0.0.1:3100/api/v1/stats
```

A wall of JSON starting `{"totalPosts":84984` means it works. Go back to the second window and press
`Ctrl+C` to stop it, then continue to Step 9.

If it didn't work, jump to [Troubleshooting](#troubleshooting).

---

## Step 9 — Run it as a service ☁️ VPS

So it starts on boot and restarts if it crashes. Create the file:

```bash
nano /etc/systemd/system/research-api.service
```

Paste this in, **replacing `VPS_USER`** with your username (`root` if that's what you SSH as):

```ini
[Unit]
Description=Viral Post Research Tool - read-only API for Hermes
After=network.target

[Service]
Type=simple
User=VPS_USER
WorkingDirectory=/srv/research-api
Environment=NODE_ENV=production
Environment=READONLY_SERVER=1
Environment=DB_PATH=/srv/research-api/snapshot.db
ExecStart=/usr/bin/node /srv/research-api/node_modules/.bin/next start -H 127.0.0.1 -p 3100
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Save and exit nano: `Ctrl+O`, `Enter`, then `Ctrl+X`.

Start it:

```bash
systemctl daemon-reload
systemctl enable --now research-api
systemctl status research-api
```

`active (running)` in green means you're done. Press `q` to exit the status view.

> The two settings doing the security work here: `READONLY_SERVER=1` refuses every write and serves
> nothing but `/api/v1`, and `-H 127.0.0.1` means only programs **on this VPS** can connect. You do
> not need to open any firewall port. If you find yourself opening one, something is wrong.

---

## Step 10 — Verify ☁️ VPS

```bash
curl -s -H "Authorization: Bearer REMOTE_TOKEN" http://127.0.0.1:3100/api/v1/stats
```

Expect `{"totalPosts":84984,...}`.

Now confirm the safety properties actually hold:

```bash
# no token -> 401
curl -s -o /dev/null -w "no token:      %{http_code}\n" http://127.0.0.1:3100/api/v1/stats
# scraping   -> 403
curl -s -o /dev/null -w "POST scrape:   %{http_code}\n" -X POST http://127.0.0.1:3100/api/scrape
# app routes -> 403
curl -s -o /dev/null -w "GET /api/posts: %{http_code}\n" http://127.0.0.1:3100/api/posts
```

You want `401`, `403`, `403`. If you get anything else, stop and check `READONLY_SERVER=1` is in the
service file.

---

## Step 11 — Point Hermes at it

Give Hermes these three things:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:3100/api/v1` |
| Auth header | `Authorization: Bearer REMOTE_TOKEN` |
| First instruction | "Call `GET /api/v1` before anything else." |

That third one matters. The API describes itself: one call returns every endpoint, filter,
enum, and default, plus an explicit list of what it cannot do. Hermes configures itself from that
instead of you hand-writing a tool spec. If Hermes imports OpenAPI schemas, point it at
`GET /api/v1/openapi.json` and it gets typed operations directly.

Useful system-prompt text to paste into Hermes:

```
You have read-only access to a research corpus of 84,984 scraped social posts
(LinkedIn, Twitter/X, Substack, Instagram) at http://127.0.0.1:3100/api/v1.
Authenticate every request with: Authorization: Bearer REMOTE_TOKEN

Call GET /api/v1 first — it returns the full endpoint and parameter reference.
Then GET /api/v1/stats to see what's actually in the corpus before filtering.

Key ideas:
- x_factor is how far a post beat its OWN author's 30-day baseline. x_factor: 12
  means 12x that account's normal engagement. It is a much better outlier signal
  than raw likes, which just resurface big accounts. It is null for authors with
  fewer than 3 prior posts.
- ?groupByImage=true clusters posts by visual similarity; ?discoverTrends=true
  clusters by content. Both need embeddings, which only 6,173 posts have, and both
  run over at most 400 candidates, so filter before grouping.
- If a response contains a "warnings" array, a filter you sent was not understood
  and was ignored, so the results are BROADER than you asked for. Do not treat
  those results as filtered.

This API is read-only. It cannot scrape, write, or reach any external service.
```

Full parameter reference: [readonly-api.md](readonly-api.md).

---

## Re-syncing after new scrapes

New posts reach Hermes only when you push a fresh snapshot. Pass your existing token so Hermes needs
no reconfiguration:

```bash
# 🖥️ MAC
cd "/Users/basia/Projects/Linkedin Tool/LinkedIn-research-tool"
npm run snapshot -- --token REMOTE_TOKEN
scp snapshot.db VPS_USER@VPS_IP:/srv/research-api/snapshot.db.new
```

```bash
# ☁️ VPS
systemctl stop research-api
mv /srv/research-api/snapshot.db.new /srv/research-api/snapshot.db
rm -f /srv/research-api/snapshot.db-wal /srv/research-api/snapshot.db-shm
systemctl start research-api
```

Swap it while stopped rather than overwriting a database that's being read.

If you changed the app code too, redo Steps 5 and 6 before restarting.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `401 Unauthorized` | Wrong token. It's the one from Step 1, **not** your local `npm run api:token` one. |
| `503` with "no token configured" | The snapshot has no token row. Rebuild it with `npm run snapshot`. |
| `403` on `/api/v1/...` | `READONLY_SERVER=1` is set but you're requesting a path outside `/api/v1`, or using a method other than GET. |
| `Connection refused` | Service isn't running. `systemctl status research-api`, then `journalctl -u research-api -n 50`. |
| `NODE_MODULE_VERSION` mismatch | `node_modules` came from your Mac. On the VPS: `rm -rf node_modules && npm ci`. |
| `totalPosts: 0` | Pointing at the wrong file. Confirm `DB_PATH` in the service file and that `/srv/research-api/snapshot.db` exists and is ~233MB. |
| Build runs out of memory | See the note under Step 6: build on your Mac, rsync `.next`. |
| `next: not found` in the service log | `npm ci` didn't finish. Re-run it in `/srv/research-api`. |

Live logs:

```bash
journalctl -u research-api -f
```

---

## What this setup guarantees

- **The VPS has none of your API keys.** The snapshot's `settings` table holds exactly one row, the
  remote token. Even a full compromise of that server cannot spend your Apify credits.
- **It cannot scrape**, both because the write routes are refused and because there are no keys to
  scrape with.
- **It is not on the internet.** Bound to `127.0.0.1`, reachable only from the VPS itself.
- **Your Mac isn't involved at runtime.** Close the laptop; Hermes keeps working against the
  snapshot.
