# Broken Product-Type Filter Detector — Google Ads Script

Detects when a **Performance Max** or **Standard Shopping** product filter has silently broken because a category was **renamed or moved** in the feed — the classic failure where `product_type`-based Asset Group / Listing Group filters start matching **0 products** and traffic quietly drops to zero while the campaign stays *Enabled*.

The script runs on a single Google Ads account, writes findings to a Google Sheet (up to four tabs), and emails a summary.

---

## Why this exists

Campaigns are segmented by `product_type` (mirroring the site's category tree). When the client renames or re-nests a category, the `product_type` string in the feed changes, but the filter pinned to the **old** string does not. The filter now matches nothing. Nothing in the Google Ads UI looks broken — the campaign is still enabled — but that segment is dead.

`custom_labels` can't be used to hard-pin categories here (all five are already used for other segmentation: sales, margins, military/civilian, etc.), so detection has to work off the live structure + inventory.

---

## What it checks (two independent signals)

| Signal | Source | Question it answers | Confidence |
|---|---|---|---|
| **Inventory** | `shopping_product` | Does this filter match **0 products right now**? | `HIGH` = 0 products (renamed/moved) · `REVIEW` = products exist but 0 `ELIGIBLE` |
| **Traffic anomaly** | `asset_group_product_group_view` / `product_group_view` | Did impressions **collapse** vs a baseline? | `HIGH` = dropped to 0 · `REVIEW` = steep partial drop |

The inventory check is the **primary** signal (it directly answers "no products"). The traffic check is the **symptom** and is cross-annotated with the current product count, so every traffic drop tells you *why*:

- traffic ↓ **and** `Products Matching Now = 0` → **broken filter** (fix the feed / filter string)
- traffic ↓ **but** products present → filter is fine, look at **bids / budget / competition / disapprovals**

> **Note on `shopping_product`:** this resource returns the products Google Ads currently sees for a campaign, *including* ones that never served — unlike `shopping_performance_view`, which only lists products that got impressions. That's what makes a true "0 products" snapshot possible.

---

## Output — Google Sheet tabs

1. **Empty Filters Snapshot** — every filter matching 0 (or 0-eligible) products. `Run Date, Channel, Confidence, Campaign, Asset Group / Ad Group, Product Type Path, Depth, Products Matching, Products Eligible, Issue`.
2. **Traffic Anomalies** — filters with collapsed impressions, annotated with current inventory. Includes `Baseline Impr, Recent Impr, Products Matching Now, …`.
3. **Run History** — one row per run: aggregate counters (`Filters Checked, Campaigns, PMax/Shopping Filters, Inv HIGH/REVIEW, Anomaly HIGH/REVIEW, Total Flags`). Use it to chart trend over time.
4. **Recurring Breakages** — rebuilt each run from the Snapshot tab: which `Campaign → Group → Product Type Path` combinations have been flagged across **multiple runs**, sorted by frequency. Surfaces the categories that break again and again.

An **email** with the two flag tables + a sheet link is sent when issues are found (configurable).

---

## Requirements

- A Google Ads account with Performance Max and/or Standard Shopping campaigns linked to Merchant Center.
- Access to **Google Ads Scripts** (Tools → Bulk actions → Scripts).
- The `shopping_product` resource must be queryable via `AdsApp.search` in your account. **Verify once** with the snippet in [Validate `shopping_product`](#validate-shopping_product) below.

---

## Setup

1. In Google Ads: **Tools → Bulk actions → Scripts → `+` New script**.
2. Paste the contents of [`broken_filter_detector_combined.js`](./broken_filter_detector_combined.js).
3. Edit the `SETTINGS` block (see [Configuration](#configuration)). At minimum set `EMAIL`. Leave `SPREADSHEET_URL` as the placeholder to have the script auto-create a sheet on first run (its URL is printed to the logs and emailed), or paste an existing sheet URL.
4. Click **Authorize** and grant access.
5. Click **Preview** / **Run** once. Check **Logs**.
6. **Schedule** it (e.g. daily, or a few times a day — the run is cheap). The inventory snapshot can run more often than the traffic check if you split them via the enable flags.

> **MCC / multiple accounts:** wrap the logic in an account iterator — replace the body of `main()` with a loop over `MccApp.accounts().get()` calling `MccApp.select(account)` per account.

---

## Configuration

All settings live in the `SETTINGS` block at the top of the script.

| Setting | Default | Purpose |
|---|---|---|
| `SPREADSHEET_URL` | `INSERT_SPREADSHEET_URL` | Target sheet. Placeholder → auto-creates one. |
| `INVENTORY_TAB` / `ANOMALY_TAB` / `HISTORY_TAB` / `RECURRING_TAB` | tab names | Sheet tab names. |
| `EMAIL` | `INSERT_EMAIL` | Recipient(s), comma-separated. |
| `EMAIL_ONLY_WHEN_ISSUES` | `true` | `false` = always send a run summary. |
| `INCLUDE_PMAX` / `INCLUDE_SHOPPING` | `true` | Which channels to scan. |
| `ENABLE_INVENTORY` | `true` | Turn the inventory (0-products) check on/off. |
| `FLAG_ZERO_ELIGIBLE` | `true` | Also flag filters where products exist but all are `NOT_ELIGIBLE`. |
| `ENABLE_TRAFFIC_ANOMALY` | `true` | Turn the impressions/clicks check on/off. |
| `BASELINE_DAYS` | `14` | Length of the "was working" baseline window. |
| `RECENT_DAYS` | `2` | Length of the recent check window. |
| `EXCLUDE_TODAY` | `true` | Skip today's partial stats (windows end yesterday). |
| `MIN_BASELINE_IMPRESSIONS` | `50` | Ignore low-volume filters in the anomaly check. |
| `FLAG_STEEP_DROP` | `true` | Also flag big partial drops (not only drops to 0). |
| `STEEP_DROP_RATIO` | `0.15` | Recent daily rate below this fraction of baseline daily rate → flag. |
| `ENABLE_HISTORY` | `true` | Append a counters row every run. |
| `ENABLE_RECURRING` | `true` | Rebuild the recurring-breakages tab. |
| `RECURRING_MIN_RUNS` | `2` | Only list paths flagged in at least this many distinct runs. |

The baseline and recent windows are **non-overlapping** by design (baseline = the period it was working, recent = the period being checked) for a cleaner signal.

---

## How it works (internals)

1. **Collect filters.** Reads `asset_group_listing_group_filter` (PMax) and `product_group_view` (Shopping) for all *enabled* leaf nodes that include by `product_type`. Rebuilds the full path (`L1 > L2 > …`) by walking parent nodes.
2. **Read inventory per campaign.** For each campaign, queries `shopping_product` scoped to that campaign and builds a count of products per `product_type` **prefix** (so a filter at any depth can be matched directly). Because it's per campaign, different feeds/languages (e.g. RU `одежда` vs UK `одяг`) never cross-match.
3. **Match & flag.** For each filter, looks up its path in the campaign's product counts → 0 products = broken. Optionally checks eligibility.
4. **Traffic anomaly.** Pulls impressions/clicks for the baseline and recent windows per filter, flags collapses, and annotates each with the current product count.
5. **Write & alert.** Appends to the Snapshot / Anomaly / History tabs, rebuilds Recurring, sends email.

---

## Assumptions & limitations

- **Product-type trees.** Assumes listing-group trees subdivide by `product_type` (your setup). Nodes that subdivide by brand / custom label are skipped for path building.
- **Exact string match.** A filter matches inventory by the **exact** `product_type` string per level. If the filter's value and the feed value differ only in **case or whitespace**, it will falsely read as 0. If you see suspiciously many flags on the first run, add normalization — a `trim().toLowerCase()` on both the product levels (in `getCampaignInventory`) and the filter values (in `buildPath`) fixes it.
- **`shopping_product` availability.** If it isn't exposed in your Scripts environment, run the equivalent logic via the Google Ads API instead. Validate first (below).
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
| Too many `HIGH` inventory flags on first run | Case/whitespace mismatch between filter values and feed — add normalization (see limitations). |
| `shopping_product` query throws | Resource not available in Scripts for your account/version → use the API, or confirm Merchant Center is linked. |
| No anomaly flags ever | `MIN_BASELINE_IMPRESSIONS` too high, or windows too short — lower the threshold / widen `BASELINE_DAYS`. |
| Empty campaign flags everything | That campaign genuinely has no products for its filters — a real issue, or the campaign/feed is misconfigured. |
| Script timeout on large accounts | Split by channel (run flags on different schedules) or scope to fewer campaigns. |

---

## Files

- `broken_filter_detector_combined.js` — the script (inventory + traffic + history + recurring).
- `README.md` — this file.

## License

MIT (or your preference).
