# Running the read-only API on your VPS

Goal: Hermes queries the corpus over `localhost` on the same VPS it runs on. Nothing is exposed to
the internet, there's no tunnel, and it doesn't depend on your Mac being awake.

```
Your Mac                              Hostinger VPS
─────────                             ─────────────
research.db  ──npm run snapshot──▶  snapshot.db
(588 MB, keys)     scp             (233 MB, no keys)
                                          │
                                    next start (READONLY_SERVER=1)
                                    bound to 127.0.0.1:3100
                                          │
                                    Hermes ──▶ /api/v1
```

The snapshot contains **no API keys** (see `scripts/export-snapshot.mjs`), so even a full compromise
of the VPS cannot spend your Apify credits or reach your accounts. It also carries no `raw_data`.

---

## 1. Build the snapshot (on your Mac)

```bash
cd LinkedIn-research-tool
npm run snapshot                 # -> ./snapshot.db, prints a NEW remote token
```

The remote token is separate from your local one. Revoking either never affects the other. Save the
printed token; you'll give it to Hermes.

## 2. Get the code onto the VPS

The commit lives only on your Mac (nothing was pushed to GitHub), so copy the working tree directly:

```bash
rsync -av --delete \
  --exclude node_modules --exclude .next --exclude .git \
  --exclude 'research.db*' --exclude coverage \
  ./ user@your-vps:/srv/research-api/
```

## 3. One-time VPS setup

`better-sqlite3` is a native module, so the VPS needs a build toolchain:

```bash
ssh user@your-vps
sudo apt-get update && sudo apt-get install -y build-essential python3
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -   # Node 20
sudo apt-get install -y nodejs

cd /srv/research-api
npm ci
npm run build
```

## 4. Ship the snapshot

```bash
# from your Mac
scp snapshot.db user@your-vps:/srv/research-api/snapshot.db
```

## 5. Run it as a service

`/etc/systemd/system/research-api.service`:

```ini
[Unit]
Description=Viral Post Research Tool — read-only API
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/srv/research-api
Environment=NODE_ENV=production
Environment=READONLY_SERVER=1
Environment=DB_PATH=/srv/research-api/snapshot.db
Environment=PORT=3100
# -H 127.0.0.1 is the security boundary: only processes ON this VPS can connect.
ExecStart=/usr/bin/npx next start -H 127.0.0.1 -p 3100
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now research-api
curl -s -H "Authorization: Bearer <remote-token>" http://127.0.0.1:3100/api/v1/stats
```

That last command should print the corpus summary. If it returns 401 the token is wrong; 503 means
the snapshot has no token row; connection refused means the service isn't up (`journalctl -u
research-api -n 50`).

## 6. Point Hermes at it

- **Base URL:** `http://127.0.0.1:3100/api/v1`
- **Header:** `Authorization: Bearer <remote-token>`
- **First instruction:** "call `GET /api/v1` before anything else" — the API describes itself, so
  Hermes learns every endpoint, filter, and enum from one call. If Hermes imports OpenAPI, give it
  `GET /api/v1/openapi.json` instead.

Full parameter reference: [readonly-api.md](readonly-api.md).

---

## Re-syncing later

New scrapes only reach Hermes when you push a fresh snapshot. Reuse the **same token** so Hermes
needs no reconfiguration:

```bash
# on your Mac
npm run snapshot -- --token <the-remote-token-you-already-gave-hermes>
scp snapshot.db user@your-vps:/srv/research-api/snapshot.db.new

# on the VPS
sudo systemctl stop research-api
mv /srv/research-api/snapshot.db.new /srv/research-api/snapshot.db
sudo systemctl start research-api
```

Swap the file while stopped rather than overwriting a database being read.

If the app code itself changed, repeat steps 2 and 3 (`rsync`, `npm ci`, `npm run build`) before
restarting.

## What to check if you ever expose this beyond the VPS

Don't, unless you have to. If you must, the token becomes internet-facing and you should put TLS and
an additional gate (Cloudflare Access, or nginx with client certs) in front of it. Binding to
`127.0.0.1` is doing real work here: it makes the API unreachable from anywhere but the VPS itself.
