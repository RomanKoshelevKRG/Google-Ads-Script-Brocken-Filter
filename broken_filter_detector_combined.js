/**
 * ============================================================================
 *  BROKEN FILTER DETECTOR — INVENTORY + TRAFFIC ANOMALY + HISTORY
 *  (Performance Max + Standard Shopping)
 * ============================================================================
 *
 *  One run writes up to four tabs of the same Google Sheet:
 *
 *  TAB 1  "Empty Filters Snapshot"   WHY — direct inventory (shopping_product)
 *    For every ENABLED product_type filter, count the campaign's CURRENT
 *    products under its product_type path.
 *      - 0 products               -> broken (category renamed/moved)       [HIGH]
 *      - products but 0 ELIGIBLE   -> exists but can't serve                [REVIEW]
 *
 *  TAB 2  "Traffic Anomalies"        SYMPTOM — impressions/clicks trend
 *    Baseline window vs recent window per filter:
 *      - had >= MIN_BASELINE_IMPRESSIONS, now 0 impressions                 [HIGH]
 *      - steep drop vs prior daily rate (optional)                         [REVIEW]
 *    Annotated with "Products Matching Now" so you see if the drop is a
 *    broken filter (0 products) or something else (bid/budget/comp).
 *
 *  TAB 3  "Run History"              one row per run: aggregate counters.
 *  TAB 4  "Recurring Breakages"      categories flagged across many runs,
 *                                    rebuilt each run from the Snapshot tab.
 *
 *  Inventory is read per campaign, so the RU/UK feed split
 *  ("одежда" vs "одяг") never cross-matches.
 *
 *  ASSUMPTION: listing-group trees subdivide by product_type (your setup).
 *  ES5-safe style for Google Ads Scripts.
 * ============================================================================
 */


// ============================== SETTINGS ====================================
var SETTINGS = {
  SPREADSHEET_URL: 'INSERT_SPREADSHEET_URL',   // leave placeholder -> auto-creates one
  INVENTORY_TAB:   'Empty Filters Snapshot',
  ANOMALY_TAB:     'Traffic Anomalies',
  HISTORY_TAB:     'Run History',
  RECURRING_TAB:   'Recurring Breakages',

  EMAIL:                  'INSERT_EMAIL',       // comma-separate for multiple
  EMAIL_ONLY_WHEN_ISSUES: true,

  // ---- Email content (the Sheet always logs everything; these only trim the email) ----
  EMAIL_SHOW_INVENTORY:      true,   // include Empty Filters Snapshot in the email
  EMAIL_INVENTORY_HIGH_ONLY: true,   // ...but only HIGH rows (skip REVIEW / 0-eligible)
  EMAIL_SHOW_CAMPAIGN_DROPS: true,   // include campaign traffic drops
  EMAIL_SHOW_GROUP_DROPS:    false,  // include asset group / ad group drops
  EMAIL_SHOW_FILTER_DROPS:   false,  // include individual filter drops

  INCLUDE_PMAX:     true,
  INCLUDE_SHOPPING: true,

  // ---- Inventory check ----
  ENABLE_INVENTORY:   true,
  // REVIEW when a path has products but none are IN STOCK — a real problem worth seeing.
  FLAG_ALL_OUT_OF_STOCK: true,
  // REVIEW when a path has products but none are ELIGIBLE. Noisy: also fires on
  // intentionally-excluded combos, so OFF by default.
  FLAG_ZERO_ELIGIBLE: false,
  // Suppress rows whose campaign / group name contains any of these (case-insensitive).
  // Use to hide known service structures you deliberately excluded.
  IGNORE_CAMPAIGNS_CONTAINING: [],
  IGNORE_GROUPS_CONTAINING: [],
  NORMALIZE_PRODUCT_TYPE: true, // trim + lowercase when matching (feed has mixed case, e.g. "ліхтарі" vs "Ліхтарі")

  // ---- Traffic anomaly: PER-FILTER (catches a single filter breaking) ----
  ENABLE_TRAFFIC_ANOMALY:   true,
  BASELINE_DAYS:            14,     // "was working" window length
  RECENT_DAYS:              2,      // "check now" window length
  EXCLUDE_TODAY:            true,   // today's stats are partial
  MIN_BASELINE_IMPRESSIONS: 50,     // ignore low-volume filters
  FLAG_STEEP_DROP:          true,   // also flag partial drops (not only ->0)
  FILTER_DROP_PCT:          0.70,   // flag a filter if its daily rate fell by > this (0.70 = -70%)

  // ---- Traffic anomaly: PER-CAMPAIGN (catches a whole campaign dipping) ----
  ENABLE_CAMPAIGN_ANOMALY:          true,
  CAMPAIGN_MIN_BASELINE_IMPRESSIONS: 200,   // ignore tiny campaigns
  CAMPAIGN_DROP_PCT:                0.30,    // flag a campaign if its daily rate fell by > this (0.30 = -30%)
  CAMPAIGN_ANOMALY_TAB:            'Campaign Anomalies',

  // ---- Traffic anomaly: PER-ASSET-GROUP / AD-GROUP (one group's products fall out) ----
  ENABLE_GROUP_ANOMALY:           true,
  GROUP_MIN_BASELINE_IMPRESSIONS: 50,      // ignore low-volume groups
  GROUP_DROP_PCT:                 0.70,     // flag a group if its daily rate fell by > this
  GROUP_ANOMALY_TAB:             'Asset Group Anomalies',

  // ---- History & recurrence ----
  ENABLE_HISTORY:     true,   // append a counters row every run
  ENABLE_RECURRING:   true,   // rebuild "which categories break repeatedly"
  RECURRING_MIN_RUNS: 2,      // only list paths flagged in >= N distinct runs

  // ---- Sheet formatting (colours, HIGH highlight, run-date separators) ----
  ENABLE_FORMATTING: true,

  // ---- Debug ----
  DEBUG: false,               // true = log baseline/recent impressions per filter & campaign
};
// ===========================================================================

var SEP = '\u001f';

// Colour palette for the sheet. HIGH is loud (red), REVIEW is deliberately pale
// so it doesn't compete for attention. Tune here without touching the logic.
var STYLE = {
  HEADER_BG: '#042C53', HEADER_FG: '#FFFFFF',
  BODY_FG:   '#2C2C2A',
  HIGH_BG:   '#FCEBEB', HIGH_FG: '#501313', HIGH_BADGE_BG: '#E24B4A', HIGH_BADGE_FG: '#FFFFFF',
  REVIEW_BG: '#FBF6EC', REVIEW_FG: '#6B5A34', REVIEW_BADGE_BG: '#F1E4C4', REVIEW_BADGE_FG: '#7A5C00',
  ZEBRA_A:   '#FFFFFF', ZEBRA_B: '#F4F2EC',
  BLOCK_BORDER: '#378ADD',
  DATE_MUTED: '#8A8A86', CRIT_TEXT: '#A32D2D', MUTED_TEXT: '#9A9A95'
};


function main() {
  var tz  = AdsApp.currentAccount().getTimeZone();
  var cid = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');

  var filters = [];
  if (SETTINGS.INCLUDE_PMAX)     filters = filters.concat(getPmaxFilters(cid));
  if (SETTINGS.INCLUDE_SHOPPING) filters = filters.concat(getShoppingFilters(cid));
  log('Collected ' + filters.length + ' product_type filters.');
  if (filters.length === 0) { finish([], [], [], [], emptyStats(), tz); return; }

  var byCampaign = groupBy(filters, 'campaignResource');
  var campaigns = objectKeys(byCampaign);

  // ---- Inventory pass ------------------------------------------------------
  var campaignInventory = {};
  var inventoryFlags = [];
  for (var c = 0; c < campaigns.length; c++) {
    var campRes = campaigns[c];
    var prefixCounts = getCampaignInventory(campRes);
    campaignInventory[campRes] = prefixCounts;

    if (SETTINGS.ENABLE_INVENTORY) {
      var cf = byCampaign[campRes];
      var seenInv = {}; // dedup: one row per group + product_type path
      for (var i = 0; i < cf.length; i++) {
        var f = cf[i];
        if (isIgnored(f.campaignName, f.groupName)) continue; // deliberately excluded structures
        var dedupKey = f.groupId + '|' + pathKey(f.pathArray);
        if (seenInv[dedupKey]) continue;
        seenInv[dedupKey] = true;
        var counts = prefixCounts[pathKey(f.pathArray)] || { total: 0, eligible: 0, inStock: 0 };
        if (counts.total === 0) {
          inventoryFlags.push(invRow(f, counts, 'HIGH',
            'Filter matches 0 products — product_type path not in the campaign feed (likely renamed/moved).'));
        } else if (SETTINGS.FLAG_ALL_OUT_OF_STOCK && availabilitySupported() && counts.inStock === 0) {
          inventoryFlags.push(invRow(f, counts, 'REVIEW',
            counts.total + ' product(s) match but 0 in stock — all out of stock.'));
        } else if (SETTINGS.FLAG_ZERO_ELIGIBLE && counts.eligible === 0) {
          inventoryFlags.push(invRow(f, counts, 'REVIEW',
            'Path exists (' + counts.total + ' product(s)) but 0 ELIGIBLE to serve.'));
        }
      }
    }
  }
  log('Inventory flags: ' + inventoryFlags.length);

  // ---- Traffic anomaly pass (per-filter) -----------------------------------
  var anomalyFlags = [];
  if (SETTINGS.ENABLE_TRAFFIC_ANOMALY) {
    anomalyFlags = detectTrafficAnomalies(filters, campaignInventory, tz);
  }
  log('Filter anomaly flags: ' + anomalyFlags.length);

  // ---- Traffic anomaly pass (per-campaign) ---------------------------------
  var campaignAnomalyFlags = [];
  if (SETTINGS.ENABLE_CAMPAIGN_ANOMALY) {
    campaignAnomalyFlags = detectCampaignAnomalies(tz);
  }
  log('Campaign anomaly flags: ' + campaignAnomalyFlags.length);

  // ---- Traffic anomaly pass (per-asset-group / ad-group) -------------------
  var groupAnomalyFlags = [];
  if (SETTINGS.ENABLE_GROUP_ANOMALY) {
    groupAnomalyFlags = detectGroupAnomalies(filters, campaignInventory, tz);
  }
  log('Group anomaly flags: ' + groupAnomalyFlags.length);

  // ---- Stats for the history tab -------------------------------------------
  var stats = {
    filters: filters.length,
    campaigns: campaigns.length,
    pmax: countBy(filters, 'channel', 'PMAX'),
    shopping: countBy(filters, 'channel', 'SHOPPING'),
    invHigh: countBy(inventoryFlags, 'confidence', 'HIGH'),
    invReview: countBy(inventoryFlags, 'confidence', 'REVIEW'),
    anoHigh: countBy(anomalyFlags, 'confidence', 'HIGH'),
    anoReview: countBy(anomalyFlags, 'confidence', 'REVIEW'),
    grpHigh: countBy(groupAnomalyFlags, 'confidence', 'HIGH'),
    grpReview: countBy(groupAnomalyFlags, 'confidence', 'REVIEW'),
    campHigh: countBy(campaignAnomalyFlags, 'confidence', 'HIGH'),
    campReview: countBy(campaignAnomalyFlags, 'confidence', 'REVIEW')
  };

  finish(inventoryFlags, anomalyFlags, groupAnomalyFlags, campaignAnomalyFlags, stats, tz);
}


/* ===========================================================================
 *  TRAFFIC ANOMALY
 * =========================================================================== */

function detectTrafficAnomalies(filters, campaignInventory, tz) {
  var off = SETTINGS.EXCLUDE_TODAY ? 1 : 0;
  var recEnd    = daysAgo(off);
  var recStart  = daysAgo(off + SETTINGS.RECENT_DAYS - 1);
  var baseEnd   = daysAgo(off + SETTINGS.RECENT_DAYS);
  var baseStart = daysAgo(off + SETTINGS.RECENT_DAYS + SETTINGS.BASELINE_DAYS - 1);
  var W = { bS: fmt(baseStart, tz), bE: fmt(baseEnd, tz), rS: fmt(recStart, tz), rE: fmt(recEnd, tz) };
  log('Baseline ' + W.bS + '..' + W.bE + ' | Recent ' + W.rS + '..' + W.rE);

  var hasPmax = false, hasShop = false;
  for (var i = 0; i < filters.length; i++) {
    if (filters[i].channel === 'PMAX') hasPmax = true; else hasShop = true;
  }

  var baseImp = {}, recImp = {};
  if (hasPmax) { mergeInto(baseImp, getPmaxImpressions(W.bS, W.bE)); mergeInto(recImp, getPmaxImpressions(W.rS, W.rE)); }
  if (hasShop) { mergeInto(baseImp, getShoppingImpressions(W.bS, W.bE)); mergeInto(recImp, getShoppingImpressions(W.rS, W.rE)); }

  var flags = [];
  for (var j = 0; j < filters.length; j++) {
    var f = filters[j];
    var b = baseImp[f.metricKey] || { imp: 0, clk: 0 };
    var r = recImp[f.metricKey]  || { imp: 0, clk: 0 };
    if (SETTINGS.DEBUG) {
      log('[filter] ' + f.channel + ' | ' + f.campaignName + ' | ' + f.displayPath +
          ' | base=' + b.imp + ' recent=' + r.imp + ' key=' + f.metricKey);
    }
    if (b.imp < SETTINGS.MIN_BASELINE_IMPRESSIONS) continue;

    var basePerDay = b.imp / SETTINGS.BASELINE_DAYS;
    var recPerDay  = r.imp / SETTINGS.RECENT_DAYS;
    var dropPct = basePerDay > 0 ? (1 - recPerDay / basePerDay) : 0; // 0..1

    var issue = null, conf = null;
    if (r.imp === 0) {
      issue = 'Impressions dropped to 0 (baseline ' + b.imp + ' impr) while campaign & group ENABLED.';
      conf = 'HIGH';
    } else if (SETTINGS.FLAG_STEEP_DROP && dropPct > SETTINGS.FILTER_DROP_PCT) {
      issue = 'Impressions down ' + Math.round(dropPct * 100) + '% vs baseline daily rate (' +
              b.imp + ' -> ' + r.imp + ' impr).';
      conf = 'REVIEW';
    }
    if (!issue) continue;

    var inv = (campaignInventory[f.campaignResource] || {})[pathKey(f.pathArray)] || { total: 0, eligible: 0 };
    flags.push({
      channel: f.channel, confidence: conf,
      campaign: f.campaignName, group: f.groupName, path: f.displayPath,
      baseImp: b.imp, baseClk: b.clk, recImp: r.imp, recClk: r.clk,
      productsNow: inv.total, eligibleNow: inv.eligible, issue: issue
    });
  }
  return flags;
}

function getPmaxImpressions(start, end) {
  var map = {};
  var q =
    'SELECT asset_group_product_group_view.asset_group_listing_group_filter, ' +
    'metrics.impressions, metrics.clicks FROM asset_group_product_group_view ' +
    "WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX' " +
    "AND campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED' " +
    "AND segments.date BETWEEN '" + start + "' AND '" + end + "'";
  var rows = AdsApp.search(q);
  while (rows.hasNext()) {
    var r = rows.next();
    var k = get(r, 'assetGroupProductGroupView.assetGroupListingGroupFilter');
    if (!k) continue;
    if (!map[k]) map[k] = { imp: 0, clk: 0 };
    map[k].imp += Number(get(r, 'metrics.impressions')) || 0;
    map[k].clk += Number(get(r, 'metrics.clicks')) || 0;
  }
  return map;
}

function getShoppingImpressions(start, end) {
  var map = {};
  var q =
    'SELECT ad_group.id, ad_group_criterion.criterion_id, metrics.impressions, metrics.clicks ' +
    'FROM product_group_view ' +
    "WHERE campaign.advertising_channel_type = 'SHOPPING' " +
    "AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' " +
    "AND segments.date BETWEEN '" + start + "' AND '" + end + "'";
  var rows = AdsApp.search(q);
  while (rows.hasNext()) {
    var r = rows.next();
    var k = String(get(r, 'adGroup.id')) + '~' + String(get(r, 'adGroupCriterion.criterionId'));
    if (!map[k]) map[k] = { imp: 0, clk: 0 };
    map[k].imp += Number(get(r, 'metrics.impressions')) || 0;
    map[k].clk += Number(get(r, 'metrics.clicks')) || 0;
  }
  return map;
}


/* ===========================================================================
 *  ASSET-GROUP / AD-GROUP ANOMALY  (one group's products fall out -> 0 impr)
 *  Uses asset_group / ad_group metrics directly (no fragile per-filter join),
 *  and annotates each flag with how many of the group's leaf filters now
 *  match 0 products — i.e. the likely cause.
 * =========================================================================== */

function detectGroupAnomalies(filters, campaignInventory, tz) {
  var off = SETTINGS.EXCLUDE_TODAY ? 1 : 0;
  var recEnd    = daysAgo(off);
  var recStart  = daysAgo(off + SETTINGS.RECENT_DAYS - 1);
  var baseEnd   = daysAgo(off + SETTINGS.RECENT_DAYS);
  var baseStart = daysAgo(off + SETTINGS.RECENT_DAYS + SETTINGS.BASELINE_DAYS - 1);
  var bS = fmt(baseStart, tz), bE = fmt(baseEnd, tz), rS = fmt(recStart, tz), rE = fmt(recEnd, tz);

  // Inventory rollup per group (also carries campaign/name so we can flag groups
  // that have NO metrics at all — i.e. dead for the whole window).
  var groupInv = {};
  for (var i = 0; i < filters.length; i++) {
    var f = filters[i];
    var gk = f.channel + '|' + f.groupId;
    if (!groupInv[gk]) groupInv[gk] = { leaves: 0, empty: 0, products: 0, seen: {},
      channel: f.channel, groupId: f.groupId, name: f.groupName, campaign: f.campaignName };
    var pk = pathKey(f.pathArray);
    if (groupInv[gk].seen[pk]) continue;       // count each product_type path once
    groupInv[gk].seen[pk] = true;
    var counts = (campaignInventory[f.campaignResource] || {})[pk] || { total: 0 };
    groupInv[gk].leaves++;
    groupInv[gk].products += counts.total;
    if (counts.total === 0) groupInv[gk].empty++;
  }

  var base = {}, rec = {};
  mergeInto(base, getGroupMetrics('PMAX', bS, bE));
  mergeInto(base, getGroupMetrics('SHOPPING', bS, bE));
  mergeInto(rec,  getGroupMetrics('PMAX', rS, rE));
  mergeInto(rec,  getGroupMetrics('SHOPPING', rS, rE));

  // Evaluate the UNION of groups seen in metrics and groups that have filters,
  // so a group that's been at 0 for the whole baseline is still evaluated.
  var allKeys = {};
  for (var k1 in base)     { if (base.hasOwnProperty(k1))     allKeys[k1] = true; }
  for (var k2 in rec)      { if (rec.hasOwnProperty(k2))      allKeys[k2] = true; }
  for (var k3 in groupInv) { if (groupInv.hasOwnProperty(k3)) allKeys[k3] = true; }

  var flags = [];
  for (var key in allKeys) {
    if (!allKeys.hasOwnProperty(key)) continue;
    var b = base[key] || { imp: 0, clk: 0 };
    var r = rec[key]  || { imp: 0, clk: 0 };
    var inv = groupInv[key] || { leaves: 0, empty: 0, products: 0 };
    var meta = base[key] || groupInv[key] || {};
    var channel = meta.channel || key.split('|')[0];
    var name = meta.name || '(unknown group)';
    var campaign = meta.campaign || '';

    var basePerDay = b.imp / SETTINGS.BASELINE_DAYS;
    var recPerDay  = r.imp / SETTINGS.RECENT_DAYS;
    var dropPct = basePerDay > 0 ? (1 - recPerDay / basePerDay) : 0;

    if (SETTINGS.DEBUG) {
      log('[group] ' + channel + ' | ' + campaign + ' > ' + name +
          ' | base=' + b.imp + ' recent=' + r.imp + ' emptyLeaves=' + inv.empty + '/' + inv.leaves);
    }

    var issue = null, conf = null;

    // (A) Drop within the window: had baseline traffic, now 0 / steep drop.
    if (b.imp >= SETTINGS.GROUP_MIN_BASELINE_IMPRESSIONS) {
      if (r.imp === 0) {
        issue = 'Group impressions dropped to 0 (baseline ' + b.imp + ' impr) while ENABLED — products likely fell out.';
        conf = 'HIGH';
      } else if (dropPct > SETTINGS.GROUP_DROP_PCT) {
        issue = 'Group impressions down ' + Math.round(dropPct * 100) + '% vs baseline (' + b.imp + ' -> ' + r.imp + ' impr).';
        conf = 'REVIEW';
      }
    }

    // (B) Timing-independent: currently not serving AND its filters match 0 products.
    //     Catches groups that have been dead longer than the baseline window
    //     (exactly the "Eligible but 0 impressions" asset group case).
    if (!issue && r.imp === 0 && inv.empty > 0) {
      issue = 'Group is Enabled but has 0 recent impressions, and ' + inv.empty + ' of ' + inv.leaves +
              ' product_type filter(s) match 0 products — products fell out of this group.';
      conf = 'HIGH';
    }

    if (!issue) continue;

    // Annotate cause (unless message already carries it).
    if (issue.indexOf('match 0 products') === -1 && inv.empty > 0) {
      issue += (inv.empty === inv.leaves)
        ? ' All ' + inv.leaves + ' filter(s) in this group now match 0 products.'
        : ' ' + inv.empty + ' of ' + inv.leaves + ' filter(s) now match 0 products.';
    }

    flags.push({
      channel: channel, confidence: conf, campaign: campaign, group: name,
      baseImp: b.imp, baseClk: b.clk, recImp: r.imp, recClk: r.clk,
      dropPct: Math.round(dropPct * 100),
      leaves: inv.leaves, empty: inv.empty, productsNow: inv.products, issue: issue
    });
  }
  return flags;
}

function getGroupMetrics(channel, start, end) {
  var map = {};
  var q;
  if (channel === 'PMAX') {
    q = 'SELECT campaign.name, asset_group.id, asset_group.name, metrics.impressions, metrics.clicks ' +
        'FROM asset_group ' +
        "WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX' " +
        "AND campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED' " +
        "AND segments.date BETWEEN '" + start + "' AND '" + end + "'";
  } else {
    q = 'SELECT campaign.name, ad_group.id, ad_group.name, metrics.impressions, metrics.clicks ' +
        'FROM ad_group ' +
        "WHERE campaign.advertising_channel_type = 'SHOPPING' " +
        "AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' " +
        "AND segments.date BETWEEN '" + start + "' AND '" + end + "'";
  }
  var rows;
  try { rows = AdsApp.search(q); }
  catch (e) { log('group metrics (' + channel + ') failed: ' + e); return map; }
  while (rows.hasNext()) {
    var r = rows.next();
    var id = channel === 'PMAX' ? String(get(r, 'assetGroup.id')) : String(get(r, 'adGroup.id'));
    var name = channel === 'PMAX' ? get(r, 'assetGroup.name') : get(r, 'adGroup.name');
    map[channel + '|' + id] = {
      channel: channel, groupId: id, name: name, campaign: get(r, 'campaign.name'),
      imp: Number(get(r, 'metrics.impressions')) || 0,
      clk: Number(get(r, 'metrics.clicks')) || 0
    };
  }
  return map;
}


/* ===========================================================================
 *  CAMPAIGN-LEVEL ANOMALY  (catches a whole campaign dipping, any cause)
 * =========================================================================== */

function detectCampaignAnomalies(tz) {
  var off = SETTINGS.EXCLUDE_TODAY ? 1 : 0;
  var recEnd    = daysAgo(off);
  var recStart  = daysAgo(off + SETTINGS.RECENT_DAYS - 1);
  var baseEnd   = daysAgo(off + SETTINGS.RECENT_DAYS);
  var baseStart = daysAgo(off + SETTINGS.RECENT_DAYS + SETTINGS.BASELINE_DAYS - 1);
  var bS = fmt(baseStart, tz), bE = fmt(baseEnd, tz), rS = fmt(recStart, tz), rE = fmt(recEnd, tz);

  var base = getCampaignMetrics(bS, bE);
  var rec  = getCampaignMetrics(rS, rE);

  var flags = [];
  for (var id in base) {
    if (!base.hasOwnProperty(id)) continue;
    var b = base[id];
    var r = rec[id] || { imp: 0, clk: 0, name: b.name, channel: b.channel };
    if (b.imp < SETTINGS.CAMPAIGN_MIN_BASELINE_IMPRESSIONS) continue;

    var basePerDay = b.imp / SETTINGS.BASELINE_DAYS;
    var recPerDay  = r.imp / SETTINGS.RECENT_DAYS;
    var dropPct = basePerDay > 0 ? (1 - recPerDay / basePerDay) : 0;

    if (SETTINGS.DEBUG) {
      log('[campaign] ' + b.name + ' | base=' + b.imp + ' recent=' + r.imp +
          ' drop=' + Math.round(dropPct * 100) + '%');
    }

    var issue = null, conf = null;
    if (r.imp === 0) {
      issue = 'Campaign impressions dropped to 0 (baseline ' + b.imp + ' impr) while ENABLED.';
      conf = 'HIGH';
    } else if (dropPct > SETTINGS.CAMPAIGN_DROP_PCT) {
      issue = 'Campaign impressions down ' + Math.round(dropPct * 100) + '% vs baseline daily rate (' +
              b.imp + ' -> ' + r.imp + ' impr).';
      conf = 'REVIEW';
    }
    if (!issue) continue;

    flags.push({
      channel: b.channel, confidence: conf, campaign: b.name,
      baseImp: b.imp, baseClk: b.clk, recImp: r.imp, recClk: r.clk,
      dropPct: Math.round(dropPct * 100), issue: issue
    });
  }
  return flags;
}

function getCampaignMetrics(start, end) {
  var map = {};
  var q =
    'SELECT campaign.id, campaign.name, campaign.advertising_channel_type, ' +
    'metrics.impressions, metrics.clicks FROM campaign ' +
    "WHERE campaign.advertising_channel_type IN ('PERFORMANCE_MAX','SHOPPING') " +
    "AND campaign.status = 'ENABLED' " +
    "AND segments.date BETWEEN '" + start + "' AND '" + end + "'";
  var rows = AdsApp.search(q);
  while (rows.hasNext()) {
    var r = rows.next();
    var id = String(get(r, 'campaign.id'));
    var ch = get(r, 'campaign.advertisingChannelType');
    map[id] = {
      name: get(r, 'campaign.name'),
      channel: ch === 'PERFORMANCE_MAX' ? 'PMAX' : 'SHOPPING',
      imp: Number(get(r, 'metrics.impressions')) || 0,
      clk: Number(get(r, 'metrics.clicks')) || 0
    };
  }
  return map;
}


/* ===========================================================================
 *  FILTER COLLECTION
 * =========================================================================== */

function getPmaxFilters(cid) {
  var nodes = {}, leaves = [];
  var q =
    'SELECT campaign.id, campaign.name, asset_group.id, asset_group.name, ' +
    'asset_group_listing_group_filter.type, ' +
    'asset_group_listing_group_filter.case_value.product_type.value, ' +
    'asset_group_listing_group_filter.parent_listing_group_filter ' +
    'FROM asset_group_listing_group_filter ' +
    "WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX' " +
    "AND campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'";
  var rows = AdsApp.search(q);
  while (rows.hasNext()) {
    var r = rows.next();
    var rn = get(r, 'assetGroupListingGroupFilter.resourceName');
    var node = {
      resourceName: rn,
      parent: get(r, 'assetGroupListingGroupFilter.parentListingGroupFilter'),
      type:  get(r, 'assetGroupListingGroupFilter.type'),
      value: get(r, 'assetGroupListingGroupFilter.caseValue.productType.value') || null,
      campaignId: String(get(r, 'campaign.id')),
      campaignName: get(r, 'campaign.name'),
      groupId: String(get(r, 'assetGroup.id')),
      groupName: get(r, 'assetGroup.name')
    };
    nodes[rn] = node;
    // Collect EVERY serving leaf (UNIT_INCLUDED), not only product_type units.
    // The product_type constraint may be inherited from ancestor subdivisions,
    // while the leaf itself is split by brand or is an "everything else" node.
    if (node.type === 'UNIT_INCLUDED') leaves.push(node);
  }
  var out = [];
  for (var li = 0; li < leaves.length; li++) {
    var lf = leaves[li];
    var p = buildPath(lf.resourceName, nodes); // inherited product_type path
    if (p.length === 0) continue;              // no product_type constraint -> skip
    out.push({ channel: 'PMAX', metricKey: lf.resourceName, groupId: lf.groupId,
      campaignResource: 'customers/' + cid + '/campaigns/' + lf.campaignId,
      campaignName: lf.campaignName, groupName: lf.groupName,
      pathArray: p, displayPath: p.join(' > ') });
  }
  return out;
}

function getShoppingFilters(cid) {
  var nodes = {}, leaves = [];
  var q =
    'SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ' +
    'ad_group_criterion.criterion_id, ' +
    'ad_group_criterion.listing_group.parent_ad_group_criterion, ' +
    'ad_group_criterion.listing_group.type, ' +
    'ad_group_criterion.listing_group.case_value.product_type.value ' +
    'FROM product_group_view ' +
    "WHERE campaign.advertising_channel_type = 'SHOPPING' " +
    "AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' " +
    "AND ad_group_criterion.status = 'ENABLED'";
  var rows = AdsApp.search(q);
  while (rows.hasNext()) {
    var r = rows.next();
    var critId = String(get(r, 'adGroupCriterion.criterionId'));
    var adGroupId = String(get(r, 'adGroup.id'));
    var rn = 'customers/' + cid + '/adGroupCriteria/' + adGroupId + '~' + critId;
    var node = {
      resourceName: rn, metricKey: adGroupId + '~' + critId, groupId: adGroupId,
      parent: get(r, 'adGroupCriterion.listingGroup.parentAdGroupCriterion'),
      type:  get(r, 'adGroupCriterion.listingGroup.type'),
      value: get(r, 'adGroupCriterion.listingGroup.caseValue.productType.value') || null,
      campaignId: String(get(r, 'campaign.id')),
      campaignName: get(r, 'campaign.name'),
      groupName: get(r, 'adGroup.name')
    };
    nodes[rn] = node;
    if (node.type === 'UNIT') leaves.push(node); // every serving leaf, any dimension
  }
  var out = [];
  for (var li = 0; li < leaves.length; li++) {
    var lf = leaves[li];
    var p = buildPath(lf.resourceName, nodes);
    if (p.length === 0) continue;
    out.push({ channel: 'SHOPPING', metricKey: lf.metricKey, groupId: lf.groupId,
      campaignResource: 'customers/' + cid + '/campaigns/' + lf.campaignId,
      campaignName: lf.campaignName, groupName: lf.groupName,
      pathArray: p, displayPath: p.join(' > ') });
  }
  return out;
}


/* ===========================================================================
 *  INVENTORY per campaign  (shopping_product)
 * =========================================================================== */

var AVAILABILITY_SUPPORTED = null; // lazily probed once

// Some API versions / Scripts environments may not expose shopping_product.availability.
// Probe once so a missing field can't break the whole inventory query.
function availabilitySupported() {
  if (AVAILABILITY_SUPPORTED !== null) return AVAILABILITY_SUPPORTED;
  try {
    var rows = AdsApp.search('SELECT shopping_product.availability FROM shopping_product LIMIT 1');
    while (rows.hasNext()) { rows.next(); }
    AVAILABILITY_SUPPORTED = true;
  } catch (e) {
    AVAILABILITY_SUPPORTED = false;
    log('shopping_product.availability not available — out-of-stock REVIEW disabled: ' + e);
  }
  return AVAILABILITY_SUPPORTED;
}

function getCampaignInventory(campaignResource) {
  var prefixCounts = {};
  var hasAvail = availabilitySupported();
  var q =
    'SELECT shopping_product.product_type_level1, shopping_product.product_type_level2, ' +
    'shopping_product.product_type_level3, shopping_product.product_type_level4, ' +
    'shopping_product.product_type_level5, shopping_product.status' +
    (hasAvail ? ', shopping_product.availability ' : ' ') +
    'FROM shopping_product WHERE shopping_product.campaign = "' + campaignResource + '"';
  var rows;
  try { rows = AdsApp.search(q); }
  catch (e) { log('shopping_product failed for ' + campaignResource + ': ' + e); return prefixCounts; }

  while (rows.hasNext()) {
    var r = rows.next();
    var levels = [
      get(r, 'shoppingProduct.productTypeLevel1'), get(r, 'shoppingProduct.productTypeLevel2'),
      get(r, 'shoppingProduct.productTypeLevel3'), get(r, 'shoppingProduct.productTypeLevel4'),
      get(r, 'shoppingProduct.productTypeLevel5')
    ];
    var isEligible = (get(r, 'shoppingProduct.status') || '').indexOf('ELIGIBLE') === 0;
    // If availability isn't available, treat every product as "in stock" so the
    // out-of-stock REVIEW branch never fires on incomplete data.
    var inStock = hasAvail ? (get(r, 'shoppingProduct.availability') === 'IN_STOCK') : true;
    var parts = [];
    for (var lvl = 0; lvl < levels.length; lvl++) {
      if (!levels[lvl]) break;
      parts.push(levels[lvl]);
      var key = pathKey(parts); // normalized to match filter paths
      if (!prefixCounts[key]) prefixCounts[key] = { total: 0, eligible: 0, inStock: 0 };
      prefixCounts[key].total++;
      if (isEligible) prefixCounts[key].eligible++;
      if (inStock) prefixCounts[key].inStock++;
    }
  }
  return prefixCounts;
}


/* ===========================================================================
 *  OUTPUT
 * =========================================================================== */

var INV_HEADERS = ['Run Date','Channel','Confidence','Campaign','Asset Group / Ad Group',
  'Product Type Path','Depth','Products Matching','Products Eligible','Issue'];
var ANO_HEADERS = ['Run Date','Channel','Confidence','Campaign','Asset Group / Ad Group',
  'Product Type Path','Baseline Impr','Baseline Clicks','Recent Impr','Recent Clicks',
  'Products Matching Now','Eligible Now','Issue'];
var GRP_HEADERS = ['Run Date','Channel','Confidence','Campaign','Asset Group / Ad Group',
  'Baseline Impr','Recent Impr','Drop %','Leaf Filters','Empty Leaves (0 products)',
  'Products Matching Now','Issue'];
var CAMP_HEADERS = ['Run Date','Channel','Confidence','Campaign','Baseline Impr','Recent Impr',
  'Drop %','Baseline Clicks','Recent Clicks','Issue'];
var HIST_HEADERS = ['Run Date','Filters Checked','Campaigns','PMax Filters','Shopping Filters',
  'Inv HIGH','Inv REVIEW','Filter Anom HIGH','Filter Anom REVIEW',
  'Group Anom HIGH','Group Anom REVIEW','Camp Anom HIGH','Camp Anom REVIEW','Total Flags'];
var REC_HEADERS = ['Channel','Campaign','Asset Group / Ad Group','Product Type Path',
  'Times Flagged (runs)','Last Seen','Last Confidence'];

function invRow(f, counts, conf, issue) {
  return { channel: f.channel, confidence: conf, campaign: f.campaignName, group: f.groupName,
    path: f.displayPath, level: 'L' + f.pathArray.length,
    total: counts.total, eligible: counts.eligible, issue: issue };
}

function finish(inventoryFlags, anomalyFlags, groupAnomalyFlags, campaignAnomalyFlags, stats, tz) {
  var ss = getSpreadsheet();
  var runDate = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');

  if (SETTINGS.ENABLE_INVENTORY && inventoryFlags.length > 0) {
    appendRows(ss, SETTINGS.INVENTORY_TAB, INV_HEADERS, inventoryFlags.map(function (f) {
      return [runDate, f.channel, f.confidence, f.campaign, f.group, f.path, f.level, f.total, f.eligible, f.issue];
    }));
  }
  if (SETTINGS.ENABLE_GROUP_ANOMALY && groupAnomalyFlags.length > 0) {
    appendRows(ss, SETTINGS.GROUP_ANOMALY_TAB, GRP_HEADERS, groupAnomalyFlags.map(function (f) {
      return [runDate, f.channel, f.confidence, f.campaign, f.group, f.baseImp, f.recImp,
        f.dropPct + '%', f.leaves, f.empty, f.productsNow, f.issue];
    }));
  }
  if (SETTINGS.ENABLE_TRAFFIC_ANOMALY && anomalyFlags.length > 0) {
    appendRows(ss, SETTINGS.ANOMALY_TAB, ANO_HEADERS, anomalyFlags.map(function (f) {
      return [runDate, f.channel, f.confidence, f.campaign, f.group, f.path,
        f.baseImp, f.baseClk, f.recImp, f.recClk, f.productsNow, f.eligibleNow, f.issue];
    }));
  }
  if (SETTINGS.ENABLE_CAMPAIGN_ANOMALY && campaignAnomalyFlags.length > 0) {
    appendRows(ss, SETTINGS.CAMPAIGN_ANOMALY_TAB, CAMP_HEADERS, campaignAnomalyFlags.map(function (f) {
      return [runDate, f.channel, f.confidence, f.campaign, f.baseImp, f.recImp,
        f.dropPct + '%', f.baseClk, f.recClk, f.issue];
    }));
  }
  if (SETTINGS.ENABLE_HISTORY) writeHistory(ss, stats, runDate);
  if (SETTINGS.ENABLE_RECURRING) rebuildRecurring(ss);

  if (SETTINGS.ENABLE_FORMATTING) {
    styleLogTab(ss, SETTINGS.INVENTORY_TAB, 2);
    styleLogTab(ss, SETTINGS.GROUP_ANOMALY_TAB, 2);
    styleLogTab(ss, SETTINGS.ANOMALY_TAB, 2);
    styleLogTab(ss, SETTINGS.CAMPAIGN_ANOMALY_TAB, 2);
    styleHistoryTab(ss, SETTINGS.HISTORY_TAB);
    styleRecurringTab(ss, SETTINGS.RECURRING_TAB);
  }

  sendEmail(ss, inventoryFlags, groupAnomalyFlags, anomalyFlags, campaignAnomalyFlags);
  log('Done. Sheet: ' + ss.getUrl());
}

function writeHistory(ss, s, runDate) {
  var total = s.invHigh + s.invReview + s.anoHigh + s.anoReview +
              s.grpHigh + s.grpReview + s.campHigh + s.campReview;
  var row = [runDate, s.filters, s.campaigns, s.pmax, s.shopping,
    s.invHigh, s.invReview, s.anoHigh, s.anoReview,
    s.grpHigh, s.grpReview, s.campHigh, s.campReview, total];
  appendRows(ss, SETTINGS.HISTORY_TAB, HIST_HEADERS, [row]);
}

// Rebuild "which categories break repeatedly" from the accumulated Snapshot tab.
function rebuildRecurring(ss) {
  var src = ss.getSheetByName(SETTINGS.INVENTORY_TAB);
  if (!src || src.getLastRow() < 2) return;
  var data = src.getDataRange().getValues(); // [Run Date,Channel,Confidence,Campaign,Group,Path,...]
  var agg = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var runDate = String(row[0]), channel = row[1], conf = row[2],
        campaign = row[3], group = row[4], path = row[5];
    var key = channel + '|' + campaign + '|' + group + '|' + path;
    if (!agg[key]) agg[key] = { channel: channel, campaign: campaign, group: group, path: path,
      runs: {}, last: '', lastConf: '' };
    agg[key].runs[runDate] = true;
    if (runDate > agg[key].last) { agg[key].last = runDate; agg[key].lastConf = conf; }
  }
  var out = [];
  for (var k in agg) {
    if (!agg.hasOwnProperty(k)) continue;
    var a = agg[k];
    var runsCount = objectKeys(a.runs).length;
    if (runsCount >= SETTINGS.RECURRING_MIN_RUNS) {
      out.push([a.channel, a.campaign, a.group, a.path, runsCount, a.last, a.lastConf]);
    }
  }
  out.sort(function (x, y) { return y[4] - x[4]; });

  var sheet = ss.getSheetByName(SETTINGS.RECURRING_TAB);
  if (!sheet) sheet = ss.insertSheet(SETTINGS.RECURRING_TAB);
  sheet.clearContents();
  sheet.appendRow(REC_HEADERS);
  sheet.getRange(1, 1, 1, REC_HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (out.length > 0) sheet.getRange(2, 1, out.length, REC_HEADERS.length).setValues(out);
  log('Recurring breakages (>=' + SETTINGS.RECURRING_MIN_RUNS + ' runs): ' + out.length);
}

function appendRows(ss, tabName, headers, rows) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) sheet = ss.insertSheet(tabName);

  if (sheet.getLastRow() === 0) {
    writeHeader(sheet, headers);
  } else {
    // Heal a stale header left by an earlier version of the script (new columns
    // were added, so row 1 no longer matches the current schema).
    var width = Math.max(sheet.getLastColumn(), headers.length);
    var existing = sheet.getRange(1, 1, 1, width).getValues()[0];
    if (!headerMatches(existing, headers)) {
      sheet.getRange(1, 1, 1, width).clearContent();
      writeHeader(sheet, headers);
    }
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

function writeHeader(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function headerMatches(existing, headers) {
  for (var i = 0; i < headers.length; i++) {
    var cell = existing[i] == null ? '' : String(existing[i]);
    if (cell !== headers[i]) return false;
  }
  for (var j = headers.length; j < existing.length; j++) {
    if (existing[j] != null && String(existing[j]) !== '') return false; // stale extra header cell
  }
  return true;
}

/* ---- Formatting ---------------------------------------------------------- */

function fillArr(n, v) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }

// True if this campaign/group was marked to skip (deliberately-excluded structures).
function isIgnored(campaignName, groupName) {
  var cn = String(campaignName || '').toLowerCase();
  var gn = String(groupName || '').toLowerCase();
  var cl = SETTINGS.IGNORE_CAMPAIGNS_CONTAINING || [];
  for (var i = 0; i < cl.length; i++) { if (cl[i] && cn.indexOf(String(cl[i]).toLowerCase()) !== -1) return true; }
  var gl = SETTINGS.IGNORE_GROUPS_CONTAINING || [];
  for (var j = 0; j < gl.length; j++) { if (gl[j] && gn.indexOf(String(gl[j]).toLowerCase()) !== -1) return true; }
  return false;
}

// Log tabs (Empty Filters / Traffic / Group / Campaign): HIGH red, REVIEW pale,
// confidence "badge" cell, zebra, run-date separators + muted repeat dates.
function styleLogTab(ss, tabName, confIdx) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 1) return;
  var nRows = sheet.getLastRow(), nCols = sheet.getLastColumn();
  var vals = sheet.getRange(1, 1, nRows, nCols).getValues();

  var bg = [fillArr(nCols, STYLE.HEADER_BG)],
      fc = [fillArr(nCols, STYLE.HEADER_FG)],
      fw = [fillArr(nCols, 'bold')];

  var prevDate = null, zebra = 0, blockStarts = [];
  for (var r = 1; r < nRows; r++) {
    var row = vals[r];
    var conf = confIdx >= 0 ? String(row[confIdx]) : '';
    var date = String(row[0]);
    var blockStart = (date !== prevDate);
    prevDate = date;
    if (blockStart) { blockStarts.push(r + 1); zebra = 0; }

    var rbg, rfc, rfw = fillArr(nCols, 'normal');
    if (conf === 'HIGH')        { rbg = fillArr(nCols, STYLE.HIGH_BG);   rfc = fillArr(nCols, STYLE.HIGH_FG); }
    else if (conf === 'REVIEW') { rbg = fillArr(nCols, STYLE.REVIEW_BG); rfc = fillArr(nCols, STYLE.REVIEW_FG); }
    else { rbg = fillArr(nCols, (zebra % 2 === 0) ? STYLE.ZEBRA_A : STYLE.ZEBRA_B); rfc = fillArr(nCols, STYLE.BODY_FG); zebra++; }

    if (confIdx >= 0 && conf === 'HIGH')   { rbg[confIdx] = STYLE.HIGH_BADGE_BG;   rfc[confIdx] = STYLE.HIGH_BADGE_FG;   rfw[confIdx] = 'bold'; }
    if (confIdx >= 0 && conf === 'REVIEW') { rbg[confIdx] = STYLE.REVIEW_BADGE_BG; rfc[confIdx] = STYLE.REVIEW_BADGE_FG; rfw[confIdx] = 'bold'; }

    if (blockStart) rfw[0] = 'bold'; else rfc[0] = STYLE.DATE_MUTED;

    bg.push(rbg); fc.push(rfc); fw.push(rfw);
  }

  var rng = sheet.getRange(1, 1, nRows, nCols);
  rng.setBackgrounds(bg); rng.setFontColors(fc); rng.setFontWeights(fw);
  if (nRows > 1 && nCols > 1) sheet.getRange(2, 2, nRows - 1, nCols - 1).setNumberFormat('#,##0');
  sheet.setFrozenRows(1);

  for (var b = 0; b < blockStarts.length; b++) {
    var br = blockStarts[b];
    if (br > 2) sheet.getRange(br, 1, 1, nCols)
      .setBorder(true, null, null, null, null, null, STYLE.BLOCK_BORDER, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  }
}

// Run History: zebra, HIGH counts in red (0 = muted), Total Flags bold.
function styleHistoryTab(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 1) return;
  var nRows = sheet.getLastRow(), nCols = sheet.getLastColumn();
  var vals = sheet.getRange(1, 1, nRows, nCols).getValues();
  var header = vals[0];

  var bg = [fillArr(nCols, STYLE.HEADER_BG)],
      fc = [fillArr(nCols, STYLE.HEADER_FG)],
      fw = [fillArr(nCols, 'bold')];

  for (var r = 1; r < nRows; r++) {
    var rbg = fillArr(nCols, (r % 2 === 1) ? STYLE.ZEBRA_A : STYLE.ZEBRA_B);
    var rfc = fillArr(nCols, STYLE.BODY_FG);
    var rfw = fillArr(nCols, 'normal');
    rfw[0] = 'bold';
    for (var c = 1; c < nCols; c++) {
      var h = String(header[c]);
      if (/HIGH/.test(h)) {
        if (Number(vals[r][c]) > 0) { rfc[c] = STYLE.CRIT_TEXT; rfw[c] = 'bold'; }
        else { rfc[c] = STYLE.MUTED_TEXT; }
      } else if (/Total Flags/.test(h)) {
        rfw[c] = 'bold';
      }
    }
    bg.push(rbg); fc.push(rfc); fw.push(rfw);
  }

  var rng = sheet.getRange(1, 1, nRows, nCols);
  rng.setBackgrounds(bg); rng.setFontColors(fc); rng.setFontWeights(fw);
  if (nRows > 1 && nCols > 1) sheet.getRange(2, 2, nRows - 1, nCols - 1).setNumberFormat('#,##0');
  sheet.setFrozenRows(1);
}

// Recurring Breakages: zebra, "Times Flagged" intensity (>=3 = red badge), coloured Last Confidence.
function styleRecurringTab(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 1) return;
  var nRows = sheet.getLastRow(), nCols = sheet.getLastColumn();
  var vals = sheet.getRange(1, 1, nRows, nCols).getValues();
  var header = vals[0];
  var timesIdx = -1, confIdx = -1;
  for (var c = 0; c < nCols; c++) {
    var h = String(header[c]);
    if (/Times Flagged/.test(h)) timesIdx = c;
    if (/Last Confidence/.test(h)) confIdx = c;
  }

  var bg = [fillArr(nCols, STYLE.HEADER_BG)],
      fc = [fillArr(nCols, STYLE.HEADER_FG)],
      fw = [fillArr(nCols, 'bold')];

  for (var r = 1; r < nRows; r++) {
    var rbg = fillArr(nCols, (r % 2 === 1) ? STYLE.ZEBRA_A : STYLE.ZEBRA_B);
    var rfc = fillArr(nCols, STYLE.BODY_FG);
    var rfw = fillArr(nCols, 'normal');
    if (timesIdx >= 0) {
      var t = Number(vals[r][timesIdx]);
      rfw[timesIdx] = 'bold';
      if (t >= 3) { rbg[timesIdx] = STYLE.HIGH_BADGE_BG; rfc[timesIdx] = STYLE.HIGH_BADGE_FG; }
      else { rfc[timesIdx] = STYLE.CRIT_TEXT; }
    }
    if (confIdx >= 0) {
      var cv = String(vals[r][confIdx]);
      if (cv === 'HIGH') { rfc[confIdx] = STYLE.HIGH_FG; rfw[confIdx] = 'bold'; }
      else if (cv === 'REVIEW') { rfc[confIdx] = STYLE.REVIEW_FG; }
    }
    bg.push(rbg); fc.push(rfc); fw.push(rfw);
  }

  var rng = sheet.getRange(1, 1, nRows, nCols);
  rng.setBackgrounds(bg); rng.setFontColors(fc); rng.setFontWeights(fw);
  sheet.setFrozenRows(1);
}

function sendEmail(ss, invFlags, grpFlags, anoFlags, campFlags) {
  if (!SETTINGS.EMAIL || SETTINGS.EMAIL.indexOf('INSERT') === 0) { log('No EMAIL set — skipping.'); return; }

  // Decide what the email will actually show (the Sheet still logs everything).
  var invShown = SETTINGS.EMAIL_INVENTORY_HIGH_ONLY ? filterByConfidence(invFlags, 'HIGH') : invFlags;
  var showInv  = SETTINGS.EMAIL_SHOW_INVENTORY;
  var showCamp = SETTINGS.EMAIL_SHOW_CAMPAIGN_DROPS;
  var showGrp  = SETTINGS.EMAIL_SHOW_GROUP_DROPS;
  var showFil  = SETTINGS.EMAIL_SHOW_FILTER_DROPS;

  var emailedTotal = (showInv ? invShown.length : 0) + (showCamp ? campFlags.length : 0) +
                     (showGrp ? grpFlags.length : 0) + (showFil ? anoFlags.length : 0);
  if (emailedTotal === 0 && SETTINGS.EMAIL_ONLY_WHEN_ISSUES) return;

  var acct = AdsApp.currentAccount().getName() + ' (' + AdsApp.currentAccount().getCustomerId() + ')';
  var subject = '[Google Ads] ' + (showInv ? invShown.length : 0) + ' broken filter(s), ' +
                (showCamp ? campFlags.length : 0) + ' campaign drop(s) — ' + acct;

  var html = '<div style="font-family:Arial,sans-serif;font-size:13px;color:#222">';
  html += '<p>Account: <b>' + esc(acct) + '</b></p>';

  if (showInv) {
    html += '<h3 style="margin:14px 0 4px">Broken filters — 0 products (HIGH) — ' + invShown.length + '</h3>';
    html += flagTable(invShown, ['channel','campaign','group','path','total','issue'],
      ['Channel','Campaign','Group','Product Type','Matching','Issue']);
  }
  if (showCamp) {
    html += '<h3 style="margin:18px 0 4px">Campaign traffic drops — ' + campFlags.length + '</h3>';
    html += flagTable(campFlags, ['confidence','channel','campaign','baseImp','recImp','dropPct','issue'],
      ['Conf.','Channel','Campaign','Base impr','Recent impr','Drop %','Issue']);
  }
  if (showGrp) {
    html += '<h3 style="margin:18px 0 4px">Asset Group / Ad Group drops — ' + grpFlags.length + '</h3>';
    html += flagTable(grpFlags, ['confidence','channel','campaign','group','baseImp','recImp','dropPct','empty','leaves','issue'],
      ['Conf.','Channel','Campaign','Group','Base impr','Recent impr','Drop %','Empty leaves','Leaves','Issue']);
  }
  if (showFil) {
    html += '<h3 style="margin:18px 0 4px">Individual filter drops — ' + anoFlags.length + '</h3>';
    html += flagTable(anoFlags, ['confidence','channel','campaign','group','path','baseImp','recImp','productsNow','issue'],
      ['Conf.','Channel','Campaign','Group','Product Type','Base impr','Recent impr','Products now','Issue']);
  }

  // Prominent link to the complete report (all tabs, incl. hidden-from-email sections).
  html += '<p style="margin-top:16px;padding:10px;background:#f2f6ff;border:1px solid #cfe0ff;border-radius:6px">' +
          '&#128202; <b>Full report</b> — all tabs (empty filters incl. REVIEW, asset-group &amp; filter drops, run history, recurring breakages):<br>' +
          '<a href="' + ss.getUrl() + '" style="font-size:14px">Open the full Google Sheet report &rarr;</a></p>';
  html += '</div>';

  MailApp.sendEmail({ to: SETTINGS.EMAIL, subject: subject, htmlBody: html });
  log('Email sent to ' + SETTINGS.EMAIL + ' (' + emailedTotal + ' items shown).');
}

function filterByConfidence(flags, conf) {
  var out = [];
  for (var i = 0; i < flags.length; i++) { if (flags[i].confidence === conf) out.push(flags[i]); }
  return out;
}

function flagTable(flags, fields, headers) {
  if (flags.length === 0) return '<p style="color:#777">None this run.</p>';
  var h = '<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#ddd"><tr style="background:#f2f2f2">';
  for (var i = 0; i < headers.length; i++) h += '<th>' + esc(headers[i]) + '</th>';
  h += '</tr>';
  var cap = Math.min(flags.length, 150);
  for (var j = 0; j < cap; j++) {
    var f = flags[j];
    var bg = f.confidence === 'HIGH' ? '#fdecec' : '#fff8e1';
    h += '<tr style="background:' + bg + '">';
    for (var k = 0; k < fields.length; k++) h += '<td>' + esc(f[fields[k]]) + '</td>';
    h += '</tr>';
  }
  h += '</table>';
  if (flags.length > cap) h += '<p>…and ' + (flags.length - cap) + ' more. See the sheet.</p>';
  return h;
}


/* ===========================================================================
 *  HELPERS
 * =========================================================================== */

function getSpreadsheet() {
  var url = SETTINGS.SPREADSHEET_URL;
  if (!url || url.indexOf('INSERT') === 0) {
    var ss = SpreadsheetApp.create('Broken Filters — Inventory + Traffic Log');
    log('No SPREADSHEET_URL — created: ' + ss.getUrl());
    return ss;
  }
  return SpreadsheetApp.openByUrl(url);
}

function buildPath(resourceName, nodes) {
  var parts = [], current = resourceName, guard = 0;
  while (current && nodes[current] && guard < 20) {
    var n = nodes[current];
    if (n.value) parts.unshift(n.value);
    current = n.parent;
    guard++;
  }
  return parts;
}

// Normalize a product_type value for matching (feed values have mixed case/spacing).
function norm(s) {
  if (s == null) return '';
  s = String(s);
  return SETTINGS.NORMALIZE_PRODUCT_TYPE ? s.replace(/^\s+|\s+$/g, '').toLowerCase() : s;
}

// Build the (normalized) lookup key for a product_type path array.
function pathKey(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push(norm(arr[i]));
  return out.join(SEP);
}

function emptyStats() {
  return { filters: 0, campaigns: 0, pmax: 0, shopping: 0,
    invHigh: 0, invReview: 0, anoHigh: 0, anoReview: 0,
    grpHigh: 0, grpReview: 0, campHigh: 0, campReview: 0 };
}
function countBy(arr, field, value) {
  var n = 0; for (var i = 0; i < arr.length; i++) { if (arr[i][field] === value) n++; } return n;
}
function mergeInto(target, src) { for (var k in src) { if (src.hasOwnProperty(k)) target[k] = src[k]; } }
function groupBy(arr, keyField) {
  var m = {};
  for (var i = 0; i < arr.length; i++) { var k = arr[i][keyField]; if (!m[k]) m[k] = []; m[k].push(arr[i]); }
  return m;
}
function get(obj, path) {
  var parts = path.split('.'), cur = obj;
  for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
  return cur;
}
function objectKeys(o) { var k = []; for (var key in o) { if (o.hasOwnProperty(key)) k.push(key); } return k; }
function daysAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return d; }
function fmt(d, tz) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); }
function esc(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function log(m) { Logger.log(m); }
