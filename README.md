# Viral Post Research Tool

A **single-user, fully-local** desktop research tool for finding viral social posts (LinkedIn +
Twitter/X). It scrapes via **Apify**, stores everything in a local **SQLite** file, enriches posts
with **embeddings** + an **x-factor** score, and shows them in a filterable UI with on-demand image
grouping and content clustering. Nothing leaves your machine except calls to Apify + Voyage (and,
optionally, Anthropic) — all made with **your own** API keys.

> **License:** This is proprietary, **source-available** software — see [Licensing](#licensing) below.
> It is not open source. Personal, non-commercial use only; don't redistribute it or use it commercially without a license.

---

## Prerequisites

1. **Node.js 20 LTS** (or newer). Check with `node -v`. If you don't have it, get it from
   [nodejs.org](https://nodejs.org/) or via [nvm](https://github.com/nvm-sh/nvm)
   (`nvm install 20 && nvm use 20`). This repo includes an `.nvmrc`, so `nvm use` picks the right one.
2. **A C/C++ build toolchain** — the app uses `better-sqlite3`, a native module that compiles when you
   install. Install the toolchain for your OS **before** `npm install`:
   - **macOS:** `xcode-select --install`
   - **Windows:** install "Desktop development with C++" via the
     [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/), or run
     `npm install --global windows-build-tools` in an admin PowerShell.
   - **Linux (Debian/Ubuntu):** `sudo apt-get install -y build-essential python3`
3. **Your own API keys** (entered in-app on first run, never in code):
   - **Apify** API token — required (scraping). https://console.apify.com/account/integrations
   - **Voyage** API key — required (embeddings). https://dash.voyageai.com/
   - **Anthropic** API key — optional (image descriptions). https://console.anthropic.com/

   > These call paid third-party services and are billed to **your** accounts.

---

## Install & run

```bash
# 1. Get the code (clone the repo you were given access to)
git clone <REPO_URL>
cd "Linkedin Research tool"

# 2. Install dependencies (this compiles better-sqlite3 for your machine)
npm install

# 3. Start the app — the SQLite database is created & migrated automatically on first run
npm run dev
```

Then open **http://localhost:3000** in your browser.

On first run the app opens on the **Settings** screen and keeps Search disabled until you paste your
**Apify token** and **Voyage key** (Anthropic optional). Use "Test connection" to verify each, then
Save. Your keys are stored only in the local database on your machine.

### First scrape
Go to **Scrape Settings** → add creators and/or keywords → **Run scrape now**. When it finishes,
open **Search** to filter by x-factor, platform, engagement, keyword, or creator, and try
**Group by image** / **Discover trends**.

---

## Troubleshooting install

- **`npm install` fails building `better-sqlite3`** — you're missing the build toolchain from
  Prerequisites step 2 (this is by far the most common issue). Install it, then re-run `npm install`.
- **Node version errors** — make sure `node -v` is 20 or newer (`nvm use` if you use nvm).
- **Can't reach the app** — the server binds to loopback for security, so use `http://localhost:3000`
  or `http://127.0.0.1:3000` (a `http://<your-LAN-ip>:3000` address will not connect, on purpose).

---

## Commands

```bash
npm run dev            # run locally (binds to 127.0.0.1); DB auto-migrates on first run
npm run build          # production build
npm start              # serve the production build locally
npm test               # full test suite (Vitest)
npm run test:coverage  # coverage report
npm run typecheck      # tsc --noEmit (strict)
```

Everything is local — no cloud, no account, no deployment. Your database lives in `research.db` in the
project folder (git-ignored; it holds your keys + scraped data — don't share it).

- **Product spec / source of truth:** [docs/prd-research-tool.md](docs/prd-research-tool.md)
- **Working rules & invariants:** [CLAUDE.md](CLAUDE.md)

---

## Licensing

© 2026 Basia Kubicka (Thane & CO, LLC). All rights reserved. This software is **proprietary and source-available**
(publicly viewable, but **not** open source) and is provided as a **free, optional educational/reference bonus**
(a reference implementation to learn from) — it is not sold as a product. See the [LICENSE](LICENSE) file for the
full terms. In short:

- You may **install and use it personally**, on your own devices, for non-commercial purposes.
- You may **not** share, redistribute, resell, publish, or give it to anyone else.
- **Commercial use or sharing with others requires a separate paid license** — contact
  **Basia Kubicka (Thane & CO, LLC) · basia@before9.am** to arrange one.

**⚠️ Beta software — no warranty, no support, use entirely at your own risk.** This is a pre-release,
experimental version, **not** a finished or commercial off-the-shelf product. It is provided **"AS IS"
and "AS AVAILABLE," with all faults**, with **no warranties of any kind** and **no support,
maintenance, or updates**. To the maximum extent permitted by law, the author accepts **no liability
whatsoever** for any damages, data loss, security breaches, data leakage, bugs, or harm to your
systems or other software arising from its use. See the [LICENSE](LICENSE) (Sections 7–15) for the
full terms. By installing or using it, you accept those terms.
