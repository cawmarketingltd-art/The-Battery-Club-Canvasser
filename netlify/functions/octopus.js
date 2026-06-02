// Netlify serverless function: live Octopus smart-tariff off-peak rate by postcode.
// Endpoint (when deployed): /.netlify/functions/octopus?tariff=iog&postcode=L19
//
// Returns JSON: { ok: true, rate: <p/kWh number>, region: "_C", tariff: "Intelligent Octopus Go" }
// or on failure:  { ok: false, reason: "..." }
//
// No API key needed — uses Octopus's public product API.

const OCTO = 'https://api.octopus.energy/v1';

const SMART = {
  iog: { name: 'Intelligent Octopus Go', fallback: 7.0 },
  go:  { name: 'Octopus Go',             fallback: 8.5 }
};

// Find the newest currently-available IMPORT product matching the display name.
async function findProduct(name) {
  let url = OCTO + '/products/?brand=OCTOPUS_ENERGY';
  let best = null;
  for (let i = 0; i < 6 && url; i++) {
    const d = await fetch(url).then(r => r.json());
    (d.results || []).forEach(p => {
      if (p.display_name === name && p.direction === 'IMPORT' && p.available_to === null) {
        if (!best || new Date(p.available_from) > new Date(best.available_from)) best = p;
      }
    });
    url = d.next;
  }
  return best;
}

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=21600' // cache 6h — rates rarely move intraday
  };

  try {
    const q = event.queryStringParameters || {};
    const t = (q.tariff || 'iog').toLowerCase();
    const pc = (q.postcode || '').trim();
    const cfg = SMART[t];

    if (!cfg) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'unknown tariff' }) };
    if (!pc)  return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'no postcode' }) };

    // 1) postcode -> grid supply point (region)
    const gsp = await fetch(OCTO + '/industry/grid-supply-points/?postcode=' + encodeURIComponent(pc)).then(r => r.json());
    const grp = gsp.results && gsp.results[0] && gsp.results[0].group_id;
    if (!grp) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'region not found', fallback: cfg.fallback }) };
    const region = grp.replace('_', '');

    // 2) find the live product
    const prod = await findProduct(cfg.name);
    if (!prod) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'product not found', fallback: cfg.fallback }) };

    // 3) product detail -> regional tariff code
    const detail = await fetch(OCTO + '/products/' + prod.code + '/').then(r => r.json());
    const reg = detail.single_register_electricity_tariffs && detail.single_register_electricity_tariffs['_' + region];
    const tcode = reg && reg.direct_debit_monthly && reg.direct_debit_monthly.code;
    if (!tcode) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'tariff code not found', fallback: cfg.fallback }) };

    // 4) unit rates -> off-peak is the lowest band
    const rates = await fetch(OCTO + '/products/' + prod.code + '/electricity-tariffs/' + tcode + '/standard-unit-rates/').then(r => r.json());
    const vals = (rates.results || []).map(r => r.value_inc_vat).filter(v => typeof v === 'number');
    if (!vals.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'no rates', fallback: cfg.fallback }) };

    const rate = Math.min(...vals);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, rate, region: '_' + region, tariff: cfg.name })
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reason: 'error: ' + e.message }) };
  }
};
