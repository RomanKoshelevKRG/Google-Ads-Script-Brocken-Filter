# Broken Product-Type Filter Detector — Google Ads Script

Detects when a **Performance Max** or **Standard Shopping** product filter has silently broken because a category was **renamed or moved** in the feed — the classic failure where a `product_type`-based Asset Group / Listing Group filter starts matching **0 products** and that segment quietly goes to zero impressions while the campaign (and even the asset group) still shows *Enabled / Eligible*.

Read-only: the script **never changes** anything in the Google Ads account. It only writes to a Google Sheet and sends email.

---

## The problem

Campaigns are segmented by `product_type` (mirroring the site's category tree). When the client renames or re-nests a category, the `product_type` string in the feed changes, but the filter pinned to the **old** string does not — so it matches nothing.

Typical symptom: an asset group like `Shopping Only / Плитоноски` sits at **0 impressions, 0 clicks** with status **Eligible**, while a sibling asset group in the same campaign serves normally. Nothing in the UI looks "off". `custom_labels` can't be used to hard-pin categories (all five are used for other segmentation: sales, margins, military/civilian, etc.), so detection works off the live structure + real inventory.

---

## What it checks

The script combines a **structural (inventory)** signal with **three levels** of **traffic** signal, so the same problem is caught whether it just happened or has been dead for weeks.

| # | Signal | Source | Answers | Timing |
|---|---|---|---|---|
| 1 | **Inventory** | `shopping_product` | Does this filter match **0 products right now**? | Any time — independent of when it broke |
| 2 | **Asset Group / Ad Group drop** | `asset_group` / `ad_group` | Did a **whole group** stop serving (and are its filters empty)? | Fresh drop **or** long-dead |
| 3 | **Campaign drop** | `campaign` | Did a **whole campaign** dip? | Fresh drop within the window |
| 4 | **Filter drop** | `asset_group_product_group_view` / `product_group_view` | Did an **individual filter** collapse? | Fresh drop within the window |

**Inventory (1) is the reliable core.** It directly answers "0 products" and doesn't depend on traffic history, so it catches the `Eligible but 0 impressions` asset group no matter how long ago it broke.

**Group (2) is the match for the "one asset group fell out" case.** It reads impressions straight from the `asset_group` / `ad_group` resource (no fragile per-filter join), and flags a group `HIGH` when **either**:
- it had baseline traffic and dropped to 0 / steeply (a fresh drop), **or**
- it is Enabled, has **0 recent impressions**, **and** its `product_type` filters currently match **0 products** — the timing-independent case, i.e. a group that's been dead longer than the baseline window.

Each group flag is annotated with `Leaf Filters`, `Empty Leaves (0 products)`, and `Products Matching Now`, so the row itself states the cause (e.g. *"3 of 4 filters now match 0 products"*).

**Campaign (3)** catches an account-wide dip that group/filter checks would miss. **Filter (4)** is the finest granularity but depends on a cross-resource join that can be brittle for PMax — use `DEBUG` to verify it, and rely on the group/inventory checks as the robust primary.

> **Why `shopping_product`:** it returns the products Google Ads currently sees for a campaign, *including* ones that never served — unlike `shopping_performance_view`, which only lists products that got impressions. That's what makes a true "0 products" snapshot possible. Scoped per campaign, so different feeds/languages (RU `одежда` vs UK `одяг`) never cross-match.

---

## Output — Google Sheet tabs

1. **Empty Filters Snapshot** — filters matching 0 (or 0-eligible) products right now. `Run Date, Channel, Confidence, Campaign, Asset Group / Ad Group, Product Type Path, Depth, Products Matching, Products Eligible, Issue`.
2. **Asset Group Anomalies** — groups that stopped serving, annotated with how many of their filters are empty. `… Baseline Impr, Recent Impr, Drop %, Leaf Filters, Empty Leaves (0 products), Products Matching Now, Issue`.
3. **Traffic Anomalies** — individual filters that collapsed, annotated with current inventory.
4. **Campaign Anomalies** — campaign-level dips.
5. **Run History** — one row per run with aggregate counters for every signal (`Inv HIGH/REVIEW, Filter Anom HIGH/REVIEW, Group Anom HIGH/REVIEW, Camp Anom HIGH/REVIEW, Total Flags`). Chart it to see trend over time.
6. **Recurring Breakages** — rebuilt each run from the Snapshot tab: which `Campaign → Group → Product Type Path` combos were flagged across **multiple runs**, sorted by frequency. Surfaces categories that break again and again.

An **email** is sent when issues are found. By default it's kept lean — only **broken filters (HIGH)** and **campaign traffic drops**, plus a prominent link to the full Sheet (which still logs *everything*: REVIEW items, group drops, filter drops, history, recurrence). Email content is fully configurable (see [Email content](#email-content)).

Confidence levels: **HIGH** = broken (0 products / dropped to 0). **REVIEW** = worth a look (products exist but 0 eligible, or a steep partial drop).

---

## Confidence & which tab catches your case

- **Asset group `Eligible` but `0 impressions` (like `Плитоноски`)** → **Empty Filters Snapshot** (always) **and** **Asset Group Anomalies** (via the timing-independent branch). If the group only recently dropped, it also appears in the drop-based part of the group tab.
- **A whole campaign dipped** → **Campaign Anomalies**.
- **A single listing-group filter within an otherwise-fine group** → **Traffic Anomalies** (fresh drop) and/or **Empty Filters Snapshot** (if it matches 0 products).

If a group shows `0 impressions` but its filters still match products (`Empty Leaves = 0`), the cause is **not** a broken filter — look at bidding / budget / ad strength / disapprovals instead. The tool intentionally does **not** flag that as a broken filter.

---

## Requirements

- Google Ads account with Performance Max and/or Standard Shopping campaigns linked to Merchant Center.
- Access to **Google Ads Scripts** (Tools → Bulk actions → Scripts).
- `shopping_product` must be queryable via `AdsApp.search` in your account — **verify once** with the snippet in [Validate `shopping_product`](#validate-shopping_product).

---

## Setup

1. Google Ads → **Tools → Bulk actions → Scripts → `+` New script**.
2. Paste [`broken_filter_detector_combined.js`](./broken_filter_detector_combined.js).
3. Edit the `SETTINGS` block ([Configuration](#configuration)). At minimum set `EMAIL`. Leave `SPREADSHEET_URL` as the placeholder to auto-create a sheet on first run (URL is logged + emailed), or paste an existing sheet URL.
4. **Authorize** and grant access.
5. **Preview / Run** once. Check **Logs**. For the first run, set `DEBUG: true` to see per-group / per-filter baseline & recent numbers.
6. **Schedule** it (daily, or a few times a day — the run is cheap). You can run cheaper checks more often by toggling the `ENABLE_*` flags.

> **MCC / multiple accounts:** wrap the body of `main()` in a loop over `MccApp.accounts().get()` calling `MccApp.select(account)` per account.

---

## Configuration

All settings live in the `SETTINGS` block at the top of the script.

### General
| Setting | Default | Purpose |
|---|---|---|
| `SPREADSHEET_URL` | `INSERT_SPREADSHEET_URL` | Target sheet. Placeholder → auto-creates one. |
| `INVENTORY_TAB` / `ANOMALY_TAB` / `GROUP_ANOMALY_TAB` / `CAMPAIGN_ANOMALY_TAB` / `HISTORY_TAB` / `RECURRING_TAB` | tab names | Sheet tab names. |
| `EMAIL` | `INSERT_EMAIL` | Recipient(s), comma-separated. |
| `EMAIL_ONLY_WHEN_ISSUES` | `true` | `false` = always send a run summary. |
| `INCLUDE_PMAX` / `INCLUDE_SHOPPING` | `true` | Which channels to scan. |
| `DEBUG` | `false` | Log baseline/recent impressions & empty-leaf counts per filter, group, and campaign. |

### Email content
The Google Sheet always logs **everything**; these flags only control what the *email* contains.

| Setting | Default | Purpose |
|---|---|---|
| `EMAIL_ONLY_WHEN_ISSUES` | `true` | `false` = always send, even with nothing to report. Gated on what the email will actually show. |
| `EMAIL_SHOW_INVENTORY` | `true` | Include the Empty Filters Snapshot section. |
| `EMAIL_INVENTORY_HIGH_ONLY` | `true` | Show only HIGH (0-products) rows; skip REVIEW / 0-eligible. |
| `EMAIL_SHOW_CAMPAIGN_DROPS` | `true` | Include campaign traffic drops. |
| `EMAIL_SHOW_GROUP_DROPS` | `false` | Include asset group / ad group drops. |
| `EMAIL_SHOW_FILTER_DROPS` | `false` | Include individual filter drops. |

Default email = **broken filters (HIGH)** + **campaign drops** + **a link to the full report**.

### Inventory (structural)
| Setting | Default | Purpose |
|---|---|---|
| `ENABLE_INVENTORY` | `true` | Turn the 0-products check on/off. |
| `FLAG_ZERO_ELIGIBLE` | `true` | Also flag filters where products exist but all are `NOT_ELIGIBLE`. |
| `NORMALIZE_PRODUCT_TYPE` | `true` | Match `product_type` case- and whitespace-insensitively (feed has mixed case, e.g. `ліхтарі` vs `Ліхтарі`). |

### Traffic — per-filter
| Setting | Default | Purpose |
|---|---|---|
| `ENABLE_TRAFFIC_ANOMALY` | `true` | On/off. |
| `BASELINE_DAYS` | `14` | "Was working" baseline window (shared by all traffic checks). |
| `RECENT_DAYS` | `2` | Recent check window (shared). |
| `EXCLUDE_TODAY` | `true` | Skip today's partial stats (shared). |
| `MIN_BASELINE_IMPRESSIONS` | `50` | Ignore low-volume filters. |
| `FLAG_STEEP_DROP` | `true` | Also flag partial drops (not only →0). |
| `FILTER_DROP_PCT` | `0.70` | Flag a filter if its daily rate fell by more than this (`0.70` = −70%). |

### Traffic — per-asset-group / ad-group
| Setting | Default | Purpose |
|---|---|---|
| `ENABLE_GROUP_ANOMALY` | `true` | On/off. **This is the check for the "one group fell out" case.** |
| `GROUP_MIN_BASELINE_IMPRESSIONS` | `50` | Ignore low-volume groups (for the drop-based branch). |
| `GROUP_DROP_PCT` | `0.70` | Flag a group if its daily rate fell by more than this. |

### Traffic — per-campaign
| Setting | Default | Purpose |
|---|---|---|
| `ENABLE_CAMPAIGN_ANOMALY` | `true` | On/off. |
| `CAMPAIGN_MIN_BASELINE_IMPRESSIONS` | `200` | Ignore tiny campaigns. |
| `CAMPAIGN_DROP_PCT` | `0.30` | Flag a campaign if its daily rate fell by more than this. |

### History & recurrence
| Setting | Default | Purpose |
|---|---|---|
| `ENABLE_HISTORY` | `true` | Append a counters row every run. |
| `ENABLE_RECURRING` | `true` | Rebuild the recurring-breakages tab. |
| `RECURRING_MIN_RUNS` | `2` | Only list paths flagged in at least this many distinct runs. |

Baseline and recent windows are **non-overlapping** by design (baseline = the period it was working, recent = the period being checked).

---

## How it works (internals)

1. **Collect filters.** Reads `asset_group_listing_group_filter` (PMax) and `product_group_view` (Shopping) for **every** enabled serving leaf (`UNIT_INCLUDED` / `UNIT`), not only ones whose own dimension is `product_type`. It rebuilds each leaf's **inherited** `product_type` path (`L1 > L2 > …`) by walking parent subdivisions — so a leaf split by *brand* (or an *"Everything else"* node) sitting under `product_type` subdivisions is still checked against its inherited category. Leaves with no `product_type` ancestor are skipped; duplicate group+path leaves are de-duplicated. Each filter carries its group id for group-level rollups.
2. **Read inventory per campaign.** For each campaign, queries `shopping_product` scoped to it and counts products per `product_type` **prefix**, so any filter depth can be matched directly. Per-campaign scoping keeps feeds/languages separate.
3. **Inventory flags.** Filter matches 0 products → broken; optional 0-eligible check.
4. **Group check.** Pulls `asset_group` / `ad_group` impressions for baseline & recent, rolls up each group's empty-filter count from step 2, and flags drops **and** timing-independent "Enabled + 0 impressions + empty filters".
5. **Campaign & filter checks.** Same baseline/recent comparison at their granularity.
6. **Write & alert.** Appends to the four flag tabs, writes Run History, rebuilds Recurring Breakages, sends email.

---

## Assumptions & limitations

- **Inherited product_type path.** The tool matches each serving leaf against the `product_type` path inherited from its ancestor subdivisions. This correctly catches the common case where an asset group subdivides by `product_type` and the serving leaf is a *brand* / *"Everything else"* node (e.g. `All products › додаткове спорядження › ліхтарі › Brand: Everything else`).
- **Brand-specific leaves.** If a leaf pins a *specific* brand under a product_type, the check looks only at the inherited product_type path, not the brand×type intersection — so a product_type that still has products but not for that brand won't be flagged. This does not affect category rename/move detection (when a path empties, all leaves under it — including brand ones — go to 0).
- **Exact string match.** A filter matches inventory by the **exact** `product_type` string per level. If the filter value and the feed value differ only in **case or whitespace**, it reads as 0. If the first run produces suspiciously many flags, add `trim().toLowerCase()` normalization to both the product levels (`getCampaignInventory`) and the filter values (`buildPath`).
- **Per-filter join.** The finest (filter-level) traffic check relies on joining `asset_group_product_group_view` to the listing-group filter; this can be brittle for PMax. The **group-level** and **inventory** checks don't use that join and are the robust primary signals. Use `DEBUG` to confirm the per-filter join in your account (if every filter shows `base=0`, the join isn't matching — rely on group/inventory).
- **`shopping_product` availability.** If it isn't exposed in your Scripts environment, run the equivalent logic via the Google Ads API. Validate first (below).
- **Single account.** Wrap in an MCC iterator for multiple accounts.
- Not legal/financial/marketing advice; validate against your own account before acting on flags.

---

## Validate `shopping_product`

Paste into a temporary script and **Preview**. If rows print with `productTypeLevel*` and `status`, you're good.

```javascript
var q = "SELECT shopping_product.item_id, shopping_product.status, " +
        "shopping_product.product_type_level1, shopping_product.product_type_level2 " +
        "FROM shopping_product LIMIT 20";
var rows = AdsApp.search(q);
while (rows.hasNext()) { Logger.log(JSON.stringify(rows.next())); }
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Asset group is `Eligible` but `0 impressions`, yet nothing in **Traffic Anomalies** | Expected — anomaly tabs catch a *drop within the window*. A long-dead group has a 0 baseline, so there's no drop to detect. It appears in **Empty Filters Snapshot** and **Asset Group Anomalies** instead. |
| **Traffic Anomalies** always empty, `DEBUG` shows `base=0` for every filter | The per-filter PMax join isn't matching in your account. Rely on the **group** + **inventory** checks (they don't use that join). |
| Too many `HIGH` inventory flags on first run | Case/whitespace mismatch between filter values and feed — add normalization (see limitations). |
| `shopping_product` query throws | Resource not available in Scripts for your account/version → use the API, or confirm Merchant Center is linked. |
| Group shows 0 impressions but `Empty Leaves = 0` and isn't flagged | Correct — its filters still match products, so it's not a broken filter. Investigate bids / budget / ad strength / disapprovals. |
| No anomaly flags ever | Thresholds too strict / windows too short — lower `*_DROP_PCT` or `*_MIN_BASELINE_IMPRESSIONS`, widen `BASELINE_DAYS`. |
| Asset group at 0 impressions **not** flagged, but its serving leaf is a *brand* / *"Everything else"* node | Fixed in v4 — the tool now checks every serving leaf against its **inherited** product_type path. Ensure you're on the latest script. |
| Real 0-product filter missed only because of casing (`ліхтарі` vs `Ліхтарі`) | Keep `NORMALIZE_PRODUCT_TYPE: true` (default) so matching is case/space-insensitive. |
| Script timeout on large accounts | Split by channel or run different `ENABLE_*` checks on separate schedules. |

---

## Permissions & safety

Read-only. The script uses only `AdsApp.search` (GAQL SELECT queries) against Google Ads — no `mutate`, no bulk uploads, no bid/status/structure changes. The only writes are to a **Google Sheet** and **email**. For extra assurance on client accounts, run it under a Google Ads user with a **read-only** role.

---

## Files

- `broken_filter_detector_combined.js` — the script (inventory + group + campaign + filter checks, history, recurrence).
- `README.md` — this file.

## Changelog

- **v4** — Collect **every** serving leaf and match on the **inherited** product_type path (catches brand / "Everything else" leaves under product_type subdivisions). Added case/whitespace **normalization** (`NORMALIZE_PRODUCT_TYPE`) and group+path de-duplication. Made the **email configurable** (`EMAIL_SHOW_*`, `EMAIL_INVENTORY_HIGH_ONLY`) — default email now sends only broken filters (HIGH) + campaign drops, with a prominent link to the full Sheet.
- **v3** — Added **per-asset-group / ad-group** anomaly tab, including a timing-independent branch that catches Enabled groups sitting at 0 impressions with empty filters. Added **per-campaign** anomaly tab. Made drop thresholds intuitive (`*_DROP_PCT`). Added `DEBUG`.
- **v2** — Added **Run History** and **Recurring Breakages** tabs.
- **v1** — Inventory (0-products) snapshot + per-filter traffic anomaly.


