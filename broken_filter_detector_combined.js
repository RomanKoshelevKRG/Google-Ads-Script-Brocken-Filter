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

  INCLUDE_PMAX:     true,
  INCLUDE_SHOPPING: true,

  // ---- Inventory check ----
  ENABLE_INVENTORY:   true,
  FLAG_ZERO_ELIGIBLE: true,   // flag filters whose products are all NOT_ELIGIBLE

  // ---- Traffic anomaly check ----
  ENABLE_TRAFFIC_ANOMALY:   true,
  BASELINE_DAYS:            14,
  RECENT_DAYS:              2,
  EXCLUDE_TODAY:            true,
  MIN_BASELINE_IMPRESSIONS: 50,
  FLAG_STEEP_DROP:          true,
  STEEP_DROP_RATIO:         0.15,

  // ---- History & recurrence ----
  ENABLE_HISTORY:     true,   // append a counters row every run
  ENABLE_RECURRING:   true,   // rebuild "which categories break repeatedly"
  RECURRING_MIN_RUNS: 2,      // only list paths flagged in >= N distinct runs
};
// ===========================================================================

var SEP = '\u001f';


function main() {
  var tz  = AdsApp.currentAccount().getTimeZone();
  var cid = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');

  var filters = [];
  if (SETTINGS.INCLUDE_PMAX)     filters = filters.concat(getPmaxFilters(cid));
  if (SETTINGS.INCLUDE_SHOPPING) filters = filters.concat(getShoppingFilters(cid));
  log('Collected ' + filters.length + ' product_type filters.');
  if (filters.length === 0) { finish([], [], emptyStats(), tz); return; }

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
      for (var i = 0; i < cf.length; i++) {
        var f = cf[i];
        var counts = prefixCounts[f.pathArray.join(SEP)] || { total: 0, eligible: 0 };
        if (counts.total === 0) {
          inventoryFlags.push(invRow(f, counts, 'HIGH',
            'Filter matches 0 products — product_type path not in the campaign feed (likely renamed/moved).'));
        } else if (SETTINGS.FLAG_ZERO_ELIGIBLE && counts.eligible === 0) {
          inventoryFlags.push(invRow(f, counts, 'REVIEW',
            'Path exists (' + counts.total + ' product(s)) but 0 ELIGIBLE to serve.'));
        }
      }
    }
  }
  log('Inventory flags: ' + inventoryFlags.length);

  // ---- Traffic anomaly pass ------------------------------------------------
  var anomalyFlags = [];
  if (SETTINGS.ENABLE_TRAFFIC_ANOMALY) {
    anomalyFlags = detectTrafficAnomalies(filters, campaignInventory, tz);
  }
  log('Traffic anomaly flags: ' + anomalyFlags.length);

  // ---- Stats for the history tab -------------------------------------------
  var stats = {
    filters: filters.length,
    campaigns: campaigns.length,
    pmax: countBy(filters, 'channel', 'PMAX'),
    shopping: countBy(filters, 'channel', 'SHOPPING'),
    invHigh: countBy(inventoryFlags, 'confidence', 'HIGH'),
    invReview: countBy(inventoryFlags, 'confidence', 'REVIEW'),
    anoHigh: countBy(anomalyFlags, 'confidence', 'HIGH'),
    anoReview: countBy(anomalyFlags, 'confidence', 'REVIEW')
  };

  finish(inventoryFlags, anomalyFlags, stats, tz);
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
    if (b.imp < SETTINGS.MIN_BASELINE_IMPRESSIONS) continue;

    var issue = null, conf = null;
    if (r.imp === 0) {
      issue = 'Impressions dropped to 0 (baseline ' + b.imp + ' impr) while campaign & group ENABLED.';
      conf = 'HIGH';
    } else if (SETTINGS.FLAG_STEEP_DROP) {
      var basePerDay = b.imp / SETTINGS.BASELINE_DAYS;
      var recPerDay  = r.imp / SETTINGS.RECENT_DAYS;
      if (recPerDay < basePerDay * SETTINGS.STEEP_DROP_RATIO) {
        var pct = Math.round((recPerDay / basePerDay) * 100);
        issue = 'Steep drop: recent daily rate ~' + pct + '% of baseline (' + b.imp + ' -> ' + r.imp + ' impr).';
        conf = 'REVIEW';
      }
    }
    if (!issue) continue;

    var inv = (campaignInventory[f.campaignResource] || {})[f.pathArray.join(SEP)] || { total: 0, eligible: 0 };
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
 *  FILTER COLLECTION
 * =========================================================================== */

function getPmaxFilters(cid) {
  var nodes = {}, leaves = [];
  var q =
    'SELECT campaign.id, campaign.name, asset_group.name, ' +
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
      groupName: get(r, 'assetGroup.name')
    };
    nodes[rn] = node;
    if (node.type === 'UNIT_INCLUDED' && node.value) leaves.push(node);
  }
  return leaves.map(function (lf) {
    var p = buildPath(lf.resourceName, nodes);
    return { channel: 'PMAX', metricKey: lf.resourceName,
      campaignResource: 'customers/' + cid + '/campaigns/' + lf.campaignId,
      campaignName: lf.campaignName, groupName: lf.groupName,
      pathArray: p, displayPath: p.join(' > ') };
  });
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
      resourceName: rn, metricKey: adGroupId + '~' + critId,
      parent: get(r, 'adGroupCriterion.listingGroup.parentAdGroupCriterion'),
      type:  get(r, 'adGroupCriterion.listingGroup.type'),
      value: get(r, 'adGroupCriterion.listingGroup.caseValue.productType.value') || null,
      campaignId: String(get(r, 'campaign.id')),
      campaignName: get(r, 'campaign.name'),
      groupName: get(r, 'adGroup.name')
    };
    nodes[rn] = node;
    if (node.type === 'UNIT' && node.value) leaves.push(node);
  }
  return leaves.map(function (lf) {
    var p = buildPath(lf.resourceName, nodes);
    return { channel: 'SHOPPING', metricKey: lf.metricKey,
      campaignResource: 'customers/' + cid + '/campaigns/' + lf.campaignId,
      campaignName: lf.campaignName, groupName: lf.groupName,
      pathArray: p, displayPath: p.join(' > ') };
  });
}


/* ===========================================================================
 *  INVENTORY per campaign  (shopping_product)
 * =========================================================================== */

function getCampaignInventory(campaignResource) {
  var prefixCounts = {};
  var q =
    'SELECT shopping_product.product_type_level1, shopping_product.product_type_level2, ' +
    'shopping_product.product_type_level3, shopping_product.product_type_level4, ' +
    'shopping_product.product_type_level5, shopping_product.status ' +
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
    var parts = [];
    for (var lvl = 0; lvl < levels.length; lvl++) {
      if (!levels[lvl]) break;
      parts.push(levels[lvl]);
      var key = parts.join(SEP);
      if (!prefixCounts[key]) prefixCounts[key] = { total: 0, eligible: 0 };
      prefixCounts[key].total++;
      if (isEligible) prefixCounts[key].eligible++;
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
var HIST_HEADERS = ['Run Date','Filters Checked','Campaigns','PMax Filters','Shopping Filters',
  'Inv HIGH','Inv REVIEW','Anomaly HIGH','Anomaly REVIEW','Total Flags'];
var REC_HEADERS = ['Channel','Campaign','Asset Group / Ad Group','Product Type Path',
  'Times Flagged (runs)','Last Seen','Last Confidence'];

function invRow(f, counts, conf, issue) {
  return { channel: f.channel, confidence: conf, campaign: f.campaignName, group: f.groupName,
    path: f.displayPath, level: 'L' + f.pathArray.length,
    total: counts.total, eligible: counts.eligible, issue: issue };
}

function finish(inventoryFlags, anomalyFlags, stats, tz) {
  var ss = getSpreadsheet();
  var runDate = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');

  if (SETTINGS.ENABLE_INVENTORY && inventoryFlags.length > 0) {
    appendRows(ss, SETTINGS.INVENTORY_TAB, INV_HEADERS, inventoryFlags.map(function (f) {
      return [runDate, f.channel, f.confidence, f.campaign, f.group, f.path, f.level, f.total, f.eligible, f.issue];
    }));
  }
  if (SETTINGS.ENABLE_TRAFFIC_ANOMALY && anomalyFlags.length > 0) {
    appendRows(ss, SETTINGS.ANOMALY_TAB, ANO_HEADERS, anomalyFlags.map(function (f) {
      return [runDate, f.channel, f.confidence, f.campaign, f.group, f.path,
        f.baseImp, f.baseClk, f.recImp, f.recClk, f.productsNow, f.eligibleNow, f.issue];
    }));
  }
  if (SETTINGS.ENABLE_HISTORY) writeHistory(ss, stats, runDate);
  if (SETTINGS.ENABLE_RECURRING) rebuildRecurring(ss);

  sendEmail(ss, inventoryFlags, anomalyFlags);
  log('Done. Sheet: ' + ss.getUrl());
}

function writeHistory(ss, s, runDate) {
  var row = [runDate, s.filters, s.campaigns, s.pmax, s.shopping,
    s.invHigh, s.invReview, s.anoHigh, s.anoReview,
    s.invHigh + s.invReview + s.anoHigh + s.anoReview];
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
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

function sendEmail(ss, invFlags, anoFlags) {
  var total = invFlags.length + anoFlags.length;
  if (total === 0 && SETTINGS.EMAIL_ONLY_WHEN_ISSUES) return;
  if (!SETTINGS.EMAIL || SETTINGS.EMAIL.indexOf('INSERT') === 0) { log('No EMAIL set — skipping.'); return; }

  var acct = AdsApp.currentAccount().getName() + ' (' + AdsApp.currentAccount().getCustomerId() + ')';
  var subject = '[Google Ads] ' + invFlags.length + ' empty filter(s), ' +
                anoFlags.length + ' traffic anomaly(ies) — ' + acct;

  var html = '<div style="font-family:Arial,sans-serif;font-size:13px;color:#222">';
  html += '<p>Account: <b>' + esc(acct) + '</b></p>';
  html += '<h3 style="margin:14px 0 4px">Empty / broken filters (inventory) — ' + invFlags.length + '</h3>';
  html += flagTable(invFlags, ['confidence','channel','campaign','group','path','total','eligible','issue'],
    ['Conf.','Channel','Campaign','Group','Product Type','Matching','Eligible','Issue']);
  html += '<h3 style="margin:18px 0 4px">Traffic anomalies — ' + anoFlags.length + '</h3>';
  html += flagTable(anoFlags, ['confidence','channel','campaign','group','path','baseImp','recImp','productsNow','issue'],
    ['Conf.','Channel','Campaign','Group','Product Type','Base impr','Recent impr','Products now','Issue']);
  html += '<p style="margin-top:14px"><a href="' + ss.getUrl() + '">Open the full log →</a></p></div>';
  MailApp.sendEmail({ to: SETTINGS.EMAIL, subject: subject, htmlBody: html });
  log('Email sent to ' + SETTINGS.EMAIL);
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

function emptyStats() {
  return { filters: 0, campaigns: 0, pmax: 0, shopping: 0,
    invHigh: 0, invReview: 0, anoHigh: 0, anoReview: 0 };
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
