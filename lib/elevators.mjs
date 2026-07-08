// The version-migration runner: apply a model's elevator ladder to a raw parsed document.

/**
 * Run a version elevator ladder over a raw parsed document. Ladder index N lifts vN -> vN+1.
 * @param {object} raw - the raw parsed document (any version; no `v` means v0).
 * @param {Function[]} ladder - elevator steps; ladder[N] takes (value, ...extra) and returns vN+1.
 * @param {number} targetVersion - the current schema version to stop at.
 * @param {...*} extra - extra args forwarded to each step (e.g. a lock's cwd).
 * @returns {object} the document elevated to targetVersion.
 */
export function elevate(raw, ladder, targetVersion, ...extra) {
  let value = { ...raw };
  let version = Number.isInteger(value.v) ? value.v : 0;
  while (version < targetVersion && ladder[version]) {
    value = ladder[version](value, ...extra);
    version = value.v;
  }
  return value;
}
