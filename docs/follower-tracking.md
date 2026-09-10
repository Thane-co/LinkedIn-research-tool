# Daily follower tracking — running it

The feature is specified in `docs/prd-research-tool.md` §21. This file is the operator's guide.

## What runs, and what it costs

One batched Apify run per day over every core LinkedIn creator, using the same profile-detail actor
as the §19 single-profile scrape.

| | |
|---|---|
| Creators captured | 67 |
| Actor tier | `Profile details no email` — $4 per 1,000 profiles |
| Per day | ~$0.27 |
| Per month | **~$8.04** |
| Wall time | ~75s for the full roster |

The roster is whatever is in `creators` with `platform = 'linkedin'`. Add or remove creators and the
cost moves with it: `creators × $0.004`.

## Running a capture

```bash
npm run followers:snapshot        # the daily job
```

Or press **Capture today** in the app's Growth tab. Both hit the same route and the same job; a
second run on the same day refreshes that day rather than adding a duplicate, so a retry after a
partial failure is always safe.

The script starts a local server if none is listening on port 3000 and stops it again on the way out,
so it works whether or not the app is already open.

## Scheduling it daily (launchd)

The schedule lives outside the app on purpose — the app never gains a cron or a scheduler.

Save as `~/Library/LaunchAgents/com.basia.linkedin-followers.plist`, then
`launchctl load ~/Library/LaunchAgents/com.basia.linkedin-followers.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.basia.linkedin-followers</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/basia/.nvm/versions/node/v20.20.2/bin/node</string>
    <string>scripts/snapshot-followers.mjs</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/basia/Projects/Linkedin Tool/07-tools/LinkedIn-research-tool</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/basia/.nvm/versions/node/v20.20.2/bin:/usr/bin:/bin</string>
  </dict>

  <!-- 06:00 local. Consistency matters more than the hour: an inconsistent capture time makes every
       delta noisier, because growth is measured between the real instants. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>0</integer>
  </dict>

  <!-- The Mac is often asleep at 06:00; without this the run is skipped entirely rather than
       deferred, and the day is simply missing from the series. -->
  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>/Users/basia/Library/Logs/linkedin-followers.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/basia/Library/Logs/linkedin-followers.log</string>
</dict>
</plist>
```

Check it: `launchctl list | grep linkedin-followers`, and read
`~/Library/Logs/linkedin-followers.log`.

**A missed day is not a corrupted series.** The growth math measures between the real instants and
reports the true `gap_days`, and a delta whose baseline is materially older than the window is
flagged `approx` in the UI (a `~` prefix). A missed day widens the gap; it never fakes a number.

## Reading the boards

- **Most followers gained** lists every creator. An em dash means "not measured yet", never zero
  growth. New creators sit at the bottom until their second capture.
- **Fastest % growth** only ranks accounts with 10,000+ followers. Below that, a rate is noise: forty
  new followers on a 200-follower account is +20%. The floor is `FOLLOWER_PERCENT_FLOOR` in
  `lib/config.ts`.
- **`stale`** means the creator's newest snapshot is more than two days old, so their numbers are
  last-known, not current.
- **`~`** means the baseline is older than the window selected, so the gain accumulated over longer
  than the window says.

## Attribution

Click a creator to see day-by-day growth with the post that earned it.

- One post that day → the day's growth is credited to that post.
- Several posts → the day says **shared across N posts** and gives no per-post number. There is no
  honest way to divide one daily total between three posts.
- No posts → the growth still shows. That is real signal: an older post catching fire, or a mention
  somewhere off-platform.

## Roster maintenance

```bash
npm run creators:prune              # dry run: what would be backfilled and removed
npm run creators:prune -- --apply   # commit it
npm run creators:prune -- --days 120
```

Prunes LinkedIn creators with no post in 90 days and backfills any missing `author_id` from the
profile url. **Deleting a creator removes them from the scrape set only** — `posts` has no foreign
key to `creators`, so every post they ever wrote stays in the corpus and stays searchable. Deleted
rows are written to `pruned-creators-<date>.json` first, so a prune is reversible.
