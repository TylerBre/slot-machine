// The agent contract is the standard plugin contract (lib/plugin/contract.mjs), re-exported
// under its original path so agent plugins and callers keep one stable import. The envelope,
// err vocabulary, and guarded call path are shared with every other plugin system (multiplexers).
export { callOp, ERR, err, ok } from '../plugin/contract.mjs';
