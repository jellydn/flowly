async function show() {
  const token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const status = document.getElementById('status');
  try {
    const id = location.pathname.split('/').at(-1);
    const response = await fetch(`/api/shares/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      status.textContent =
        'Link unavailable, expired, or revoked. Ask the publisher for a new link.';
      return;
    }
    const shared = await response.json();
    status.textContent = `Visibility: bearer-link · Expires ${shared.expiresAt} · ${shared.snapshot.mode} run`;
    const report = document.getElementById('report');
    report.hidden = false;
    const heading = document.createElement('h2');
    heading.textContent = 'Metrics and reproducibility lineage';
    const data = document.createElement('pre');
    data.textContent = JSON.stringify(
      { snapshotDigest: shared.snapshotDigest, ...shared.snapshot },
      null,
      2,
    );
    report.append(heading, data);
  } catch {
    status.textContent = 'Shared report unavailable. Open the original complete link to retry.';
  }
}
show();
