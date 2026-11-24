// Shared by the browser and CLI. No model judge, API, or network dependency.
const fields = ['yer', 'saat', 'kanal'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const sameKeys = (x, keys) => record(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const norm = s => s.normalize('NFC').trim();

export function parseResponse(raw, entities, validSources) {
  let value = raw;
  if (typeof value === 'string') {
    // Whitespace only is tolerated: fences, explanations and duplicate keys fail.
    value = JSON.parse(value);
    const keyCount = [...raw.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].length;
    if (keyCount !== 18) throw new Error('Duplicate or unexpected JSON keys.');
  }
  if (!sameKeys(value, ['durum', 'kaynak'])) throw new Error('Top-level keys must be durum and kaynak.');
  for (const section of ['durum', 'kaynak']) {
    if (!sameKeys(value[section], entities)) throw new Error('Event identifiers do not match.');
    for (const entity of entities) {
      if (!sameKeys(value[section][entity], fields)) throw new Error('Fields must be yer, saat, and kanal.');
      for (const field of fields) {
        const v = value[section][entity][field];
        if (typeof v !== 'string') throw new Error('All field values must be strings.');
        if (section === 'kaynak' && !validSources.includes(norm(v))) throw new Error('Invalid source message identifier.');
      }
    }
  }
  return value;
}

export function scoreCase(test, raw) {
  const result = {id: test.id, pair_id: test.pair_id, family: test.family,
    submitted: raw !== undefined && raw !== null && raw !== '', valid: false,
    state_correct: 0, source_correct: 0, joint_correct: 0, total_fields: 6,
    state_exact: false, joint_exact: false, errors: []};
  try {
    if (!result.submitted) throw new Error('Missing response.');
    const answer = parseResponse(raw, test.entities, test.messages.map(m => m.id));
    result.valid = true;
    for (const entity of test.entities) for (const field of fields) {
      const s = norm(answer.durum[entity][field]) === norm(test.expected.durum[entity][field]);
      const p = norm(answer.kaynak[entity][field]) === test.expected.kaynak[entity][field];
      result.state_correct += Number(s); result.source_correct += Number(p); result.joint_correct += Number(s && p);
      if (!s || !p) result.errors.push({entity, field, kind: !s ? 'value' : 'source',
        expected: {value: test.expected.durum[entity][field], source: test.expected.kaynak[entity][field]},
        actual: {value: answer.durum[entity][field], source: answer.kaynak[entity][field]}});
    }
    result.state_exact = result.state_correct === 6;
    result.joint_exact = result.joint_correct === 6;
  } catch (e) { result.errors.push({kind: 'format', message: e.message}); }
  return result;
}

function aggregate(rows) {
  const n = rows.length;
  const sum = key => rows.reduce((s, r) => s + Number(r[key]), 0);
  const pct = (v, d) => d ? Math.round(v / d * 10000) / 100 : 0;
  const pairs = new Map();
  for (const r of rows) { if (!pairs.has(r.pair_id)) pairs.set(r.pair_id, []); pairs.get(r.pair_id).push(r); }
  const pairRows = [...pairs.values()];
  return {n, submitted: sum('submitted'), valid: sum('valid'), coverage: pct(sum('submitted'), n),
    format_rate: pct(sum('valid'), n), state_accuracy: pct(sum('state_correct'), n*6),
    source_accuracy: pct(sum('source_correct'), n*6), joint_field_accuracy: pct(sum('joint_correct'), n*6),
    state_exact: pct(sum('state_exact'), n), joint_exact: pct(sum('joint_exact'), n),
    pairs: pairRows.length, pair_exact: pct(pairRows.filter(rs => rs.length===2 && rs.every(r => r.joint_exact)).length, pairRows.length)};
}

// Seeded cluster bootstrap within family. The pair is the resampling unit.
export function confidenceInterval(rows, iterations = 2000) {
  let seed = 566;
  const rand = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.family)) groups.set(r.family, new Map());
    const g = groups.get(r.family);
    if (!g.has(r.pair_id)) g.set(r.pair_id, []);
    g.get(r.pair_id).push(r);
  }
  if (!rows.length) return [0, 0];
  const scores = [];
  for (let i=0; i<iterations; i++) {
    let correct=0, n=0;
    for (const g of groups.values()) {
      const pairs=[...g.values()];
      for(let j=0; j<pairs.length; j++) for(const r of pairs[Math.floor(rand()*pairs.length)]) { correct += Number(r.joint_exact); n++; }
    }
    scores.push(correct/n*100);
  }
  scores.sort((a,b)=>a-b);
  return [scores[Math.floor(iterations*.025)], scores[Math.min(iterations-1, Math.floor(iterations*.975))]].map(x=>Math.round(x*100)/100);
}

export function evaluate(dataset, submission, split='test') {
  if (!['test', 'dev'].includes(split)) throw new Error('Split must be test or dev.');
  if (!record(submission) || !Array.isArray(submission.responses)) throw new Error('A JSON object containing a responses array is required.');
  if (submission.benchmark_version !== dataset.version) throw new Error('Benchmark version mismatch.');
  if (typeof submission.model !== 'string' || !submission.model.trim()) throw new Error('A model identifier is required.');
  const allowed = new Set(dataset.cases.map(c=>c.id));
  const byId = new Map();
  for(const r of submission.responses) {
    if (!record(r) || !allowed.has(r.id)) throw new Error('Unknown case identifier.');
    if (byId.has(r.id)) throw new Error('Duplicate case identifier: '+r.id);
    byId.set(r.id, r.response);
  }
  const cases = dataset.cases.filter(c=>c.split===split);
  const rows = cases.map(c=>scoreCase(c, byId.get(c.id)));
  const overall = aggregate(rows);
  return {benchmark_version:dataset.version, model:submission.model, run_type:submission.run_type || 'unverified-upload',
    split, ...overall, complete:overall.submitted===cases.length, ci95_joint_exact:confidenceInterval(rows),
    families:Object.fromEntries(Object.keys(dataset.families).map(f=>[f, aggregate(rows.filter(r=>r.family===f))])), rows};
}
