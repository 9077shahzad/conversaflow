// Decision rules for the dependency audit, kept apart from the command-line script so tests can import them
// without running the audit (independent review L1).
/** Decides each advisory's outcome. Exported for the unit tests in scripts/audit-deps.test.mjs. */
export function evaluate(advisories, prodIds, exceptions, today, allowProposed) {
  return Object.values(advisories).map((a) => {
    const id = a.github_advisory_id;
    const scope = prodIds.has(id) ? 'production' : 'development';
    const blocking = scope === 'production' || ['high', 'critical'].includes(a.severity);
    const ex = exceptions.find((e) => e.advisory === id && e.package === a.module_name);
    let outcome = blocking ? 'FAIL' : 'reported (moderate/low, development only)';
    if (blocking && ex) {
      if (ex.scope !== scope)
        outcome = `FAIL (exception covers ${ex.scope} only; found in ${scope})`;
      else if (ex.expires < today) outcome = `FAIL (exception expired ${ex.expires})`;
      else if (!ex.owner || !ex.reviewBy || ex.reviewBy > ex.expires)
        outcome = 'FAIL (exception lacks an owner or a review date before expiry)';
      else if (ex.reviewBy < today)
        outcome = `FAIL (exception review overdue since ${ex.reviewBy})`;
      else if (ex.status === 'approved' && ex.approvedBy)
        outcome = `excepted until ${ex.expires}, review by ${ex.reviewBy} (owner ${ex.owner}, approved by ${ex.approvedBy})`;
      else if (allowProposed)
        outcome = `PROPOSED exception, not yet approved (allowed for this local run only)`;
      else outcome = 'FAIL (exception proposed, awaiting owner approval)';
    }
    const paths = [...new Set(a.findings.flatMap((f) => f.paths))].slice(0, 3).join('; ');
    return {
      id,
      pkg: a.module_name,
      severity: a.severity,
      scope,
      fix: a.patched_versions,
      paths,
      outcome,
      title: a.title,
    };
  });
}
