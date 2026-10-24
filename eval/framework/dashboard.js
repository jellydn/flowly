const $ = (id) => document.getElementById(id);
const number = (value, suffix = '') =>
  value == null || !Number.isFinite(value) ? 'Unknown' : `${value}${suffix}`;
const rate = (value) =>
  value == null || !Number.isFinite(value) ? 'Not measured' : `${Math.round(value * 100)}%`;
const cost = (value) =>
  value == null || !Number.isFinite(value) ? 'Unknown' : `$${value.toFixed(4)}`;
const node = (tag, text) => {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
};
let reports = [];
let revision = 0;

function fill(select, values, placeholder) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ''));
  for (const [value, label] of values) select.add(new Option(label, value));
  if (values.some(([value]) => value === previous)) select.value = previous;
}

async function compare() {
  const current = ++revision;
  const baseline = reports.find((report) => report.runId === $('baseline').value);
  const candidate = reports.find((report) => report.runId === $('candidate').value);
  $('details').replaceChildren();
  for (const report of [baseline, candidate]) {
    if (!report) continue;
    const card = node('article', '');
    card.append(
      node('h3', report.model),
      node('p', `${report.runId} · ${report.mode} · ${report.judge}`),
    );
    card.append(
      node(
        'p',
        `Quality ${rate(report.summary.qualityScore)} · Cost ${cost(report.summary.costUsd)}`,
      ),
    );
    card.append(
      node(
        'pre',
        `Suite: ${report.lineage?.suiteDigest ?? 'Missing lineage'}\nCorpus: ${report.lineage?.repositoryDigest ?? 'Missing lineage'}`,
      ),
    );
    for (const result of report.results) {
      const evidence = node('details', '');
      evidence.append(
        node(
          'summary',
          `${result.passed ? 'PASS' : 'FAIL'} · ${result.id} · ${rate(result.quality)} · ${result.workload}`,
        ),
      );
      evidence.append(
        node(
          'p',
          `${number(result.latency, 'ms')} · ${number(result.tokens, ' tokens')} · ${cost(result.cost)} · Tools ${result.tools ? 'OK' : 'failed'} · Patch ${result.patch == null ? 'not measured' : result.patch ? 'applies' : 'fails'} · Human ${result.human == null ? 'unreviewed' : result.human ? 'accepted' : 'rejected'}`,
        ),
      );
      evidence.append(node('pre', result.evidence));
      card.append(evidence);
    }
    $('details').append(card);
  }
  $('regression').textContent = 'Select two runs to check regression status.';
  if (!baseline || !candidate) return;
  try {
    const response = await fetch(
      `/api/regression?${new URLSearchParams({ baseline: baseline.runId, candidate: candidate.runId })}`,
    );
    const result = response.ok ? await response.json() : null;
    const message = result
      ? result.passed
        ? 'No quality regression detected.'
        : `Regression detected: ${result.regressedScenarioIds.join(', ')}`
      : await response.text();
    if (current === revision) $('regression').textContent = message;
  } catch {
    if (current === revision)
      $('regression').textContent = 'Regression check unavailable. Please reload.';
  }
}

function render() {
  const filtered = reports.filter(
    (report) =>
      (!$('suite').value || report.suiteId === $('suite').value) &&
      (!$('model').value || report.model === $('model').value) &&
      (!$('mode').value || report.mode === $('mode').value) &&
      (!$('since').value || report.ranAt >= $('since').value),
  );
  $('status').textContent = filtered.length
    ? `${filtered.length} saved runs · ${filtered.filter((report) => report.failed).length} with failed scenarios`
    : reports.length
      ? 'No runs match these filters.'
      : 'No saved reports yet. Run npm run eval -- run first.';
  $('runs').replaceChildren();
  for (const report of [...filtered].sort(
    (a, b) => b.summary.qualityScore - a.summary.qualityScore,
  )) {
    const row = node('tr', '');
    const model = node('td', report.model);
    model.append(
      node('small', `${report.suiteId} · ${report.runId}`),
      node('small', `${report.ranAt} · ${report.mode}`),
    );
    row.append(model);
    const summary = report.summary;
    for (const text of [
      rate(summary.qualityScore),
      number(summary.avgLatencyMs, 'ms'),
      number(summary.totalTokens),
      cost(summary.costUsd),
      rate(summary.toolSuccessRate),
      rate(summary.patchApplicabilityRate),
      rate(summary.humanAcceptanceRate),
      report.failed ? `${report.failed} failed` : 'Passed',
    ])
      row.append(node('td', text));
    row.lastChild.className = report.failed ? 'bad' : 'good';
    $('runs').append(row);
  }
  for (const id of ['baseline', 'candidate'])
    fill(
      $(id),
      filtered.map((report) => [report.runId, `${report.model} · ${report.runId}`]),
      'Select a run',
    );
  compare();
}

async function main() {
  try {
    const response = await fetch('/api/reports');
    if (!response.ok) throw new Error('load');
    reports = await response.json();
    for (const [id, field] of [
      ['suite', 'suiteId'],
      ['model', 'model'],
    ])
      fill(
        $(id),
        [...new Set(reports.map((report) => report[field]))].sort().map((value) => [value, value]),
        `All ${id}s`,
      );
    for (const id of ['suite', 'model', 'mode', 'since']) $(id).addEventListener('change', render);
    for (const id of ['baseline', 'candidate']) $(id).addEventListener('change', compare);
    render();
  } catch {
    $('status').textContent = 'Could not load reports. Check the results directory and reload.';
  }
}
main();
