# ML Draft Lab — Chapter 1 (Match Mode)

*Draft Smarter. Play the Composition.*

## Run

```
node server.js        # → http://localhost:5173
npm test              # headless engine smoke test
```

No dependencies or build step. Plain ES modules.

## Using Match Mode (live logging)

Click hero → logged → role inferred → continue.

1. **Mode**: **Ranked Draft** is the default: forgiving, hero-first, with grouped bans. **Tournament / MPL** enforces the MPL PH sequence. **Free Draft** is for experiments.
2. **Bans** are entered in grouped blocks: your 3 → enemy 3 → your 2 → enemy 2. The board moves to the next block on its own.
3. **Picks**: click the hero you see picked. It's logged in pick order (Pick 1, Pick 2, …) and its role is **inferred**. All of a side's auto-assigned picks are re-solved together, so picking a pure jungler moves a flex jungler to its other lane, for example. Pick order never changes.
4. **Switch role**: click the role under any pick to open the switcher. Choosing a role that's already taken swaps the two heroes. A role you set stays put until you choose "Back to auto". Composition, needs, recommendations and the coach all update right away.
5. **Out of order**: click a team's next empty pick slot to log that team's pick out of sequence.
6. **Wrong hero?** **↺ Start over** (tap twice) clears everything: picks, bans, roles, phase, timer and history. Undo (Ctrl+Z) still reverts single actions.

Other shortcuts: just start typing to search, Enter takes the first match, 1–4 takes a recommendation, and right-clicking a hero toggles it in your pool. **My pool** groups your pool by role, with the role being drafted first.

The pick log keeps `{ order, side, hero, assignedRole, roleSource: 'auto' | 'manual' }` for each pick. Roles are a separate layer on top of pick order.

## My draft (personal layer)

The **My draft** card in the coach panel sets **My role** and **My hero**. The hero list shows your pool for that role first.

- **Auto-detect**: if My hero is undecided, the hero your team picks into your role becomes My hero (marked "auto-detected"). It sticks while that hero is on your team. A hero you choose by hand always wins.
- **Role lock**: "I am playing Jungle Suyou" is treated as fact. Role inference moves your teammates around you, never you.
- **Personal guide** (`src/personalGuide.js`): first works out your hero's *function in this composition*. The same hero can have a different job: Tigreal is the primary engager, or secondary engage / peel when another reliable engager is already on the team. It then gives your job, what to do, what to watch, your key synergies, what to avoid, and a role-specific plan (Jungle: tempo, first Turtle, invades, targets, roam/mid; EXP: side lane, frontline vs damage, rotations, split, entry; Mid: wave, rotation, zone, setup; Gold: farm, scaling, positioning, survival, when to join; Roam: engage/peel, vision, frontline, who to protect, rotation). If your hero is a poor fit for the final composition, it says so and reframes your responsibility.
- **For you vs. theoretical**: when your pool pick differs from the best overall pick, the coach explains the trade-off component by component. A clearly stronger out-of-pool hero (+1.5 draft fit or more) is flagged as a compelling option.

## Draft rating

**Draft rating (0–10)** measures how coherent and favorable your composition is from the picks made. **It is not a win probability.** Each of your five picks is scored on the eight sub-scores in the final context. These are averaged and combined with two team-level checks (unmet needs, matchup against the enemy draft) into: composition quality, synergy, counter value, win-condition clarity, role coverage, meta value, enemy matchup and player fit (your hero's proficiency). All inputs are returned by `engine.rateDraft()`.

| Rating | Label |
|---|---|
| 9.0–10 | Excellent Draft |
| 8.0–8.9 | Strong Draft |
| 7.0–7.9 | Favorable |
| 6.0–6.9 | Playable / Slight Edge |
| 5.0–5.9 | Even |
| 4.0–4.9 | Difficult |
| < 4.0 | Very Difficult |

## Ranked blind bans

Ranked Draft records bans as **events**: `{ side, wave, slot, hero | null, result: 'ban' | 'double' | 'no-ban' }`. Legality depends on the format:

| | Ranked Draft (`banMode: blind`) | Tournament / MPL (`sequential`) | Free Draft (`free`) |
|---|---|---|---|
| Ban order | Waves: your bans, then the enemy's, which together form one simultaneous wave | Visible and alternating | Anything |
| Same hero banned by both sides | Allowed inside the same unrevealed wave ("Double ban") | Rejected | Off by default (`allowDuplicateBans`) |
| No ban | Allowed: the slot shows `—`, the draft advances, no hero is blocked | Not allowed | Allowed |
| Hero unavailable | Once the wave is revealed (all its slots entered) | Immediately | Immediately |

**Ranked flow (verified in-game):** one blind ban phase (your 5, then the enemy's 5, revealed together), then picks **B1 · R2 · B2 · R2 · B2 · R1**. There is no second ban phase. The format declares `banPhaseCount: 1`, `blindBans: true`, `secondBanPhase: false` and `pickOrder`, and these are validated against the phases when the format loads. Tournament / MPL declares `banPhaseCount: 2`, `firstBanPerSide: 3` and `secondBanPerSide: 2`. The **Rank bracket** picker (Mythic 5 · Legend 4 · Epic 3 bans, each a single phase) comes from `data/draft-formats.json → RANKED_DRAFT.brackets`.

## Hero roster vs. meta data

- **Roster** (`data/heroes.json`): every current MLBB hero, reconciled against the Mobile Legends wiki with `node tools/check-roster.js` (`--snapshot` stores the list in `data/roster.json` for offline tests). Non-hero wiki pages and unreleased heroes (Dori, Noctis) are excluded there, with reasons.
- **Meta** (`data/meta/…`): how heroes performed in one dataset. A roster hero absent from a complete dataset gets an explicit zero record (0 picks, bans, wins and losses; win rate unavailable). Nothing is inferred from other seasons. Such a hero is fully usable in Match Mode.

## Role-first picking

On your team's pick turn, **Pick for** [EXP · Jungle · Mid · Gold · Roam] chooses which team role to recommend for. This is the `recommendationRole`, separate from `myRole` / `myHero`, which only drive the personal guide. It defaults to the suggested next role (green dot), and switching roles never changes the draft.

- **Role need**: what the composition needs from that role, with a one-line "why" (e.g. *"Your team already has frontline and engage but lacks damage."*).
- **Enemy threat**: the top enemy threat and what this role should compensate with (e.g. Gold vs dive: prefer stronger self-protection). It also feeds the ranking, so self-sufficient backliners rise against dive.
- **Best / Safe / Counter**: three cards, each with draft fit, function tags, reasons and **Select**. Select logs the hero into that role. When the enemy has no picks yet, Counter becomes Alternative. Keys 1–3 work too.
- **Your pool**: when the role is your role, your pool leads ("Best for you" vs "Best overall"). A pool pick within 1.5 draft fit is preferred, and a much stronger off-pool hero is flagged as a *Compelling off-pool pick*.

After the draft, the main panel is the guide: rating → compositions → **How should we play?** (win condition, lose condition, early, mid, late) → **Your role** (job, priorities, watch for, avoid) → **Draft coach** (enemy threat, priority target, **priority objective** with reason). The sidebar becomes a summary.

## Draft formats

Formats live in `data/draft-formats.json` and are data, not code. Each one sets its phases (side order per phase), timers, bans and picks per side, whether it is enforced, whether roles can flex, and whether there is a swap phase. The draft engine (`src/draftState.js`) compiles and enforces whichever one is active.

- **Ranked Draft** (`RANKED_DRAFT`, default): the everyday live-logging mode. Bans are grouped by side using relative tokens (`a`/`e` = your side / enemy side), and picks follow the snake order as a guide. It isn't strict: any side's next pick can be logged out of order.
- **Tournament · MPL PH S18** (`MPL_PH_S18`): enforced. Only the side whose turn it is can act, and only with the current action. Picks and bans are final (Undo corrects input mistakes), and role swaps are allowed. Its `verification` block records what is confirmed and what is not. Confirmed: the in-game Tournament Mode drives the draft, there is a swap phase, sides are chosen by coin toss and then by the loser, and there are 10 bans. Not yet confirmed by an official MPL PH source: the exact per-action order and the timers.
- **Free Draft**: any pick or ban on any slot, in any order, with removal and undo. For learning and testing.

`draft.status()` returns `{ phase, phaseIndex, phaseLabel, side, actionType, actionNumber, timer, availableHeroes, pickedHeroes, bannedHeroes, ... }`.

## Recommendation engine v1

Every candidate gets eight visible sub-scores (0–1): `metaScore`, `roleFit`, `compositionFit`, `synergyScore`, `counterScore`, `draftPriority`, `playerFit` and `winConditionFit`. They combine with stage-dependent weights into `draftFit`. Meta value counts most on blind picks and less as heroes are revealed. Counter value grows with each enemy pick. Player fit only counts in "Your pool" mode.

`engine.analyze(draft, side, { usePool })` returns `topPick`, `alternative`, `counterPick`, `why`, `teamNeed`, `enemyThreat`, `archetype`, the scored `rows`, and `explainNotTop(heroId)`, which explains why a hero isn't #1.

`npm test` runs the deterministic reasoning drafts (A: weak frontline, B: vulnerable enemy backline, C: already durable team, D: enemy dive, E: meta-high but incompatible) plus the format enforcement tests.

## Architecture

| Layer | File | Owns |
|---|---|---|
| Game data | `data/heroes.json`, `src/heroDatabase.js` | Heroes, lanes, 13 draft attributes, archetype tags, counters |
| Meta | `data/meta/*.json`, `src/metaData.js` | Pick/ban/win stats → presence and ban rate |
| Player | `src/playerProfile.js` | Pool by role, stars, notes (localStorage) |
| Draft state | `src/draftState.js` | Picks, bans, sequence formats, target, undo |
| Composition engine | `src/compositionEngine.js` | Archetypes, needs, threats, win condition, post-draft plan, itemization |
| Recommendation engine | `src/recommendationEngine.js` | Pick/ban scoring, reasons, PICK NOW / FLEX / COUNTER / HOLD / DENY tags |
| UI | `src/ui/*` | Rendering and input only |

Draft Fit = weighted role fit + needs filled + synergy + counter value + meta value. The weights change as the draft goes on: meta matters most for blind picks, and needs and counters matter more later. **Deep analysis** shows the breakdown.

## Data layers (no rebuild)

```
data/heroes.json                 official hero identity (patch-independent)
data/meta/index.json             manifest: which season/patch dataset is active
data/meta/mpl-ph-s18.json        hero stats (picks, bans, wins, losses, winRate, presence)
data/meta/mpl-ph-s18-usage.json  OBSERVED competitive usage (lanes only from draft-slot evidence)
data/drafts/mpl-ph-s18.json      game-by-game draft log (picks with role, bans, winner, game id)
```

- **Import verified hero stats** (CSV header: `Hero,Picks,Bans,Wins,Losses,WinRate,Presence`):

  ```
  node tools/import-hero-stats.js stats.csv --drafts 172 --source "MPL PH Season 18 (source, date)"
  ```

  This checks every row: hero names must be in `heroes.json`, wins + losses must equal picks, and any given WinRate/Presence must match the counts (presence = (picks + bans) / 172). It writes nothing if any check fails. Nothing is estimated.
- **Current dataset**: MPL PH S18. The source table is kept at `data/meta/sources/mpl-ph-s18-hero-stats.csv` (85 heroes; totals check out: 1,720 picks, 1,720 bans, 860 wins vs 860 losses). Re-run the command above to regenerate the JSON.
- **New season or patch**: import to a new `--id`, add it to `data/meta/index.json`, and set `active`.
- **Draft log**: `src/draftLog.js` loads it, checks each game (`validateGame`) and computes hero totals and pair counts. It isn't used by Match Mode yet.
- **Heroes** (`data/heroes.json` v0.2): each hero has a primary lane, weighted flex lanes, class(es), draft functions, composition archetypes, 0–3 ratings (frontline, engage, cc, burst, damage, poke, mobility, peel, sustain, objective, dive, early, scaling), counter flags and a `profile` status (`reviewed` / `baseline` / `provisional`). Heroes with distinct forms (Sora) list `forms`, and the engine scores the form that fits the draft. The full schema is at the top of the file. `tools/apply-reviewed-profiles.py` holds the user-reviewed profiles.
- **Observed usage**: `node tools/build-usage.js` rebuilds the usage file. Lanes are filled in only when the draft log has a role on each pick. Flex heroes that were picked are flagged for verification. Nothing is guessed.
- **Portraits**: put one image per hero at `public/assets/heroes/<heroId>.webp`, named by hero id (e.g. `yisunshin.webp`, not `yss.webp`). They're served at `/assets/heroes/...`. `data/hero-portraits.json` can override the URL for any hero. The UI tries `hero.portraitUrl`, then the local file, then a role placeholder, so a missing image never breaks anything. `node tools/download-hero-portraits.js` fills them in automatically. It finds each hero's official portrait through the Mobile Legends Fandom wiki API and saves it as `<heroId>.webp`, using ffmpeg to convert when needed. If the image host refuses a download, it saves the image's web link in `hero-portraits.json → remote` so the browser still loads the real portrait. Re-run it later to save files locally (`--force` re-downloads everything). `node tools/check-portraits.js` reports how many are saved locally, linked by URL or missing. Artwork © Moonton, for personal use of this tool. The full list of expected filenames is in `public/assets/heroes/README.md`.

## Match rooms, spectators and sharing

**Create match** (header) opens a live room such as `MLDL-7K4P` and moves you to `/match/MLDL-7K4P` as the **host**. Send the link to friends: they join as **spectators**.

- **Host**: the full Draft Desk. Only the host can ban, pick, change roles, set My role / My hero, undo, reset or end the match. The host's browser keeps a random host token (`localStorage`). Every change publishes the shared match state.
- **Spectators**: read-only. They see the live board, the phase, the role being filled, its need, the enemy threat and the current top 5, then the full Coaching Lab once the draft is complete. Every action that changes the draft is blocked in the UI. The server also rejects any write without the host token.
- **Lifecycle**: `WAITING` → `LIVE` → `COMPLETE`. A completed (or ended) room is read-only for everyone, including the host.
- **What is shared** (`src/matchState.js`): the draft engine's authoritative snapshot (format, side, bracket, pick log with role assignments, ban log: hero ids only) plus its action log. It also carries My role / My hero, the role being inspected and the host's pool. Each viewer rebuilds every recommendation, the Draft Rating and the coaching report locally with the same engines. Because the host's pool travels with the state, results are identical for everyone.
- **Share final draft**: once a draft is complete, copies a read-only link (`/#share=…`, about 600 characters). The whole result is in the URL; no database is needed.

### Transports

| Where | Rooms run on | Setup |
|---|---|---|
| `node server.js` | the built-in relay (`/api/rooms`, server-sent events, in memory) | none; `HOST=0.0.0.0 node server.js` lets friends on your network join |
| Vercel | **Supabase Realtime** | run `supabase/schema.sql` once; set `SUPABASE_URL` + `SUPABASE_ANON_KEY` |

If `SUPABASE_URL` / `SUPABASE_ANON_KEY` are set, the local server also uses Supabase. Only the **publishable (anon) key** is ever sent to browsers. Writes go through `create_match` / `update_match` / `end_match` functions, which check the host token (stored hashed in a table the API cannot read). Never configure a service-role key.

### Deploy (GitHub → Vercel)

1. Push the repo to GitHub and import it in Vercel. `vercel.json` sets framework *Other*, no build step and the project root as output. It also rewrites `/match/:code` to the app and `/assets/*` to `public/assets/*`.
2. In Supabase: SQL editor → run `supabase/schema.sql`, then `supabase/migrations/002_live_sync.sql`. The migration is non-destructive: it adds read grants for spectators, a `revision` counter and the realtime publication.
3. In Vercel → Settings → Environment Variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (see `.env.example`).
4. `api/config.js` serves those two public values to the app.

**Sync model**: Supabase is the source of truth in production. Every accepted host write (host-token-checked RPC) gets the next `revision`. Spectators fetch the room, subscribe to that room's row changes, and fetch again on every (re)subscription. They also re-fetch when the page becomes visible or the network returns, and poll slowly only while realtime is disconnected. A revision at or below the one shown is ignored as stale.

**Diagnostics**: add `?debug=1` to a match URL to show connection, room, revision and last-sync time (console lines are prefixed `[room]`). Add `?spectate=1` to open your own room read-only as a spectator.

Tests: `npm test` runs the room relay end-to-end in-process (`tests/sharing.test.js`): create, join, live picks and bans, read-only spectators, refresh, room isolation and completed rooms.
