// The shared plugin contract (agents, multiplexers): the OK/ERR envelope, the closed err
// vocabulary, and callOp - the one guarded call path and the only place plugin code is
// trusted. Design narrative: lib/plugin/README.md.

export const ERR = {
  NOT_INSTALLED: 'not-installed',
  UNSUPPORTED: 'unsupported',
  UNPARSEABLE: 'unparseable',
  AGENT_ERROR: 'agent-error',
  CRASHED: 'crashed',
  CONFIG: 'config',
  TIMEOUT: 'timeout',
};

const ERR_KINDS = new Set(Object.values(ERR));

/**
 * A success envelope.
 * @param {*} value - the op-specific result.
 * @returns {{ok: true, value: *}} - a success envelope.
 */
export const ok = value => ({ ok: true, value });

/**
 * A failure envelope.
 * @param {string} kind - one of ERR.
 * @param {string} [detail] - human-readable detail.
 * @returns {{ok: false, err: string, detail: string}} - a failure envelope.
 */
export const err = (kind, detail = '') => ({ ok: false, err: kind, detail });

/**
 * The guarded call path: invoke plugin[op](args) and always return a well-formed envelope.
 * A missing op -> unsupported; a throw or a malformed/unknown-err return -> agent-error.
 * Synchronous: drive ops are sync, and doctor/setup use spawnSync.
 * @param {object} plugin - the plugin object.
 * @param {string} op - the op name.
 * @param {object} [args] - the op arguments.
 * @returns {{ok: boolean, value?: *, err?: string, detail?: string}} - a well-formed envelope.
 */
export function callOp(plugin, op, args = {}) {
  if (typeof plugin?.[op] !== 'function')
    return err(ERR.UNSUPPORTED, `${plugin?.name ?? 'plugin'} has no op '${op}'`);
  let out;
  try {
    out = plugin[op](args); // method call, not a detached fn(args), so a plugin op can use `this`
  }
  catch (ex) {
    return err(ERR.AGENT_ERROR, ex?.message ?? String(ex));
  }
  if (!out || typeof out !== 'object' || typeof out.ok !== 'boolean')
    return err(ERR.AGENT_ERROR, `op '${op}' returned a non-envelope`);
  if (out.ok === false && !ERR_KINDS.has(out.err))
    return err(ERR.AGENT_ERROR, `op '${op}' returned unknown err '${out.err}'`);
  return out;
}
