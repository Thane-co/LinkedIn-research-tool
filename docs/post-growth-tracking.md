# Post growth tracking — running it

Spec: `docs/prd-research-tool.md` §22. This is the operator's guide.

## What it costs, and why this one isn't free

The follower capture is cheap because it reads one profile per creator. This job is different: it
re-reads every recent **post**, and the actor bills **per post returned** — including posts it has
already seen. That is not waste, it is the measurement: you cannot know how a post grew without
reading it again.

Measured on the first real run:

| | |
|---|---|
| Creators | 55 |
| Posts read | 538 |
| Cost | **$1.08** |
| Wall time | 53s |
| **Per month** | **~$32** |

Rate is $0.002/post on your STARTER plan, falling to $0.00175 and $0.0015 at higher Apify spend
tiers. Combined with follower tracking ($6.60), the whole tracking stack is **~$39/month**.

### The cost lever is the window
The actor's `postedLimit` has no 2-day or 3-day setting — it's `any|1h|24h|week|month|…`. The job
uses `week` (`ENGAGEMENT_REFRESH_TIMEFRAME` in `lib/config.ts`) and does the day-1/2/3 comparison in
the database instead. If you ever want it cheaper, the levers in order of bluntness:

1. `maxPosts` cap per profile in `buildLinkedInCreatorInput` — truncates heavy posters first.
2. Drop to `24h` — halves the cost, but each post is measured once and you lose the curve entirely.
3. Run every other day — halves the cost, halves the resolution.

## Running it

```bash
npm run posts:refresh
```

Re-running the same day refreshes that day rather than duplicating it, so a retry after a failure is
always safe. The script starts a local server if none is listening and stops it again afterwards.

## Scheduling it daily (launchd)

Same pattern as follower tracking. Save as
`~/Library/LaunchAgents/com.basia.linkedin-post-growth.plist` and `launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.basia.linkedin-post-growth</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/basia/.nvm/versions/node/v20.20.2/bin/node</string>
    <string>scripts/refresh-engagement.mjs</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/basia/Projects/Linkedin Tool/07-tools/LinkedIn-research-tool</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/basia/.nvm/versions/node/v20.20.2/bin:/usr/bin:/bin</string>
  </dict>

  <!-- 06:30, half an hour after the follower capture so the two never contend for the server. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>30</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/basia/Library/Logs/linkedin-post-growth.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/basia/Library/Logs/linkedin-post-growth.log</string>
</dict>
</plist>
```

**Capture at a consistent hour.** Post age drives which day-N slot a measurement fills, and the slot
has half a day of tolerance. A capture that drifts by several hours starts missing slots, which shows
up as em dashes rather than wrong numbers — but you lose the comparison.

## Reading the board

Growth tab, under the champion leaderboard.

- **Day 1 / Day 2 / Day 3** — total engagement at that *post age*, not that calendar day. This is what
  makes two posts comparable. An em dash means the post is not that old yet.
- **+Today** — what the latest measurement added. This is the sort order, so the top of the table is
  what is moving now, not what was biggest ever.
- **% late** — the share of engagement that arrived after day one. **The number worth reading.** Two
  posts can finish identically, one having taken it all in an afternoon, the other compounding for
  three days. Only the second is a format you can repeat.
- **climbing** — the latest day added 5%+ of the post's running total, so it hasn't finished yet.

## What it can't tell you yet

The curve needs two captures. After the first run every post shows dashes — that is correct, not a
bug. Day-2 and day-3 columns fill in as posts age through the window.
