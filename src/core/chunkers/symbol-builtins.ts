/**
 * Language builtins / stdlib members that a call-graph edge can never resolve
 * to a user symbol, used to explain WHY an edge stayed unmatched.
 *
 * The edge extractor emits bare callee tokens (`trim`, `map`, `string`), so a
 * `references` edge to `Promise` and a `calls` edge to `push` both look
 * exactly like a call into user code that the resolver failed to find. They
 * are not failures — they are edges out of the indexed corpus.
 *
 * This list is a REASON classifier, never a resolution gate: it is only ever
 * consulted after the same-page candidate lookup already came back empty, and
 * after cross-file lookup ruled out a real user-defined symbol of that name.
 * A project that defines its own `get()` therefore still gets classified as
 * `cross_file_same_source`, not as a builtin.
 *
 * Deliberately not exhaustive. It covers the head of the distribution (the
 * tokens that dominate real brains); the tail lands in `no_candidate_anywhere`,
 * which is the honest answer for "we don't know".
 */

/** Types + globals every TS/JS surface sees, plus the common prototype methods. */
const JS_TS = new Set([
  // TS structural / primitive types (edge_type = 'references')
  'string', 'number', 'boolean', 'void', 'unknown', 'any', 'never', 'object',
  'symbol', 'bigint', 'null', 'undefined', 'this',
  'Promise', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
  'Exclude', 'Extract', 'ReturnType', 'Parameters', 'Awaited', 'NonNullable',
  'Array', 'ReadonlyArray', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date',
  'RegExp', 'Error', 'Iterable', 'Iterator', 'AsyncIterable', 'Function',
  // Globals / constructors
  'console', 'JSON', 'Math', 'Object', 'String', 'Number', 'Boolean', 'BigInt',
  'Symbol', 'Proxy', 'Reflect', 'globalThis', 'process', 'Buffer',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'structuredClone', 'fetch', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'AbortController', 'AbortSignal', 'Float32Array', 'Uint8Array',
  // Prototype methods the extractor emits bare
  'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every',
  'flat', 'flatMap', 'includes', 'indexOf', 'lastIndexOf', 'slice', 'splice',
  'concat', 'join', 'push', 'pop', 'shift', 'unshift', 'sort', 'reverse',
  'trim', 'trimStart', 'trimEnd', 'split', 'replace', 'replaceAll', 'match',
  'matchAll', 'startsWith', 'endsWith', 'padStart', 'padEnd', 'repeat',
  'toLowerCase', 'toUpperCase', 'toString', 'valueOf', 'charAt', 'charCodeAt',
  'substring', 'get', 'set', 'has', 'delete', 'add', 'clear', 'keys', 'values',
  'entries', 'from', 'of', 'isArray', 'stringify', 'parse', 'assign', 'freeze',
  'then', 'catch', 'finally', 'all', 'allSettled', 'race', 'resolve', 'reject',
  'log', 'warn', 'error', 'info', 'debug', 'trace',
  'call', 'apply', 'bind', 'toFixed', 'toISOString', 'getTime', 'now',
]);

/** React hooks — ambient in every .tsx corpus, defined in node_modules. */
const REACT = new Set([
  'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useContext',
  'useReducer', 'useLayoutEffect', 'useImperativeHandle', 'useTransition',
  'useDeferredValue', 'useId', 'useSyncExternalStore',
]);

const PYTHON = new Set([
  'len', 'print', 'str', 'int', 'float', 'bool', 'list', 'dict', 'tuple',
  'set', 'frozenset', 'bytes', 'type', 'repr', 'hash', 'id', 'range',
  'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'sum', 'min',
  'max', 'abs', 'round', 'any', 'all', 'open', 'input', 'isinstance',
  'issubclass', 'getattr', 'setattr', 'hasattr', 'delattr', 'super', 'iter',
  'next', 'format', 'vars', 'dir', 'callable', 'exec', 'eval',
  // dominant str/list/dict methods emitted bare
  'append', 'extend', 'insert', 'remove', 'pop', 'index', 'count', 'copy',
  'update', 'setdefault', 'items', 'keys', 'values', 'get', 'clear',
  'strip', 'lstrip', 'rstrip', 'split', 'rsplit', 'splitlines', 'join',
  'replace', 'startswith', 'endswith', 'lower', 'upper', 'title', 'encode',
  'decode', 'find', 'rfind', 'add', 'discard', 'read', 'write', 'close',
]);

const GO = new Set([
  'len', 'cap', 'make', 'new', 'append', 'copy', 'delete', 'panic', 'recover',
  'print', 'println', 'close', 'complex', 'real', 'imag', 'string', 'int',
  'int8', 'int16', 'int32', 'int64', 'uint', 'byte', 'rune', 'float32',
  'float64', 'bool', 'error', 'any',
]);

const RUST = new Set([
  'println', 'print', 'format', 'vec', 'panic', 'assert', 'assert_eq',
  'assert_ne', 'write', 'writeln', 'unwrap', 'expect', 'clone', 'into',
  'to_string', 'as_str', 'iter', 'collect', 'push', 'pop', 'insert', 'remove',
  'len', 'is_empty', 'contains', 'get', 'map', 'filter', 'unwrap_or',
  'unwrap_or_else', 'ok_or', 'and_then', 'Some', 'None', 'Ok', 'Err',
  'String', 'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'HashMap', 'HashSet',
]);

const RUBY = new Set([
  'puts', 'print', 'p', 'require', 'require_relative', 'raise', 'loop',
  'each', 'map', 'select', 'reject', 'reduce', 'inject', 'find', 'include?',
  'push', 'pop', 'shift', 'unshift', 'length', 'size', 'first', 'last',
  'to_s', 'to_i', 'to_f', 'to_a', 'to_h', 'freeze', 'dup', 'nil?', 'empty?',
  'new', 'attr_accessor', 'attr_reader', 'attr_writer',
]);

const JAVA = new Set([
  'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character',
  'Byte', 'Short', 'Object', 'List', 'ArrayList', 'Map', 'HashMap', 'Set',
  'HashSet', 'Optional', 'Stream', 'Collectors', 'System', 'Math', 'Arrays',
  'Collections', 'Exception', 'RuntimeException',
  'get', 'put', 'add', 'remove', 'size', 'isEmpty', 'contains', 'toString',
  'equals', 'hashCode', 'valueOf', 'length', 'charAt', 'substring', 'trim',
  'split', 'join', 'format', 'println', 'printf', 'stream', 'collect',
]);

const BY_LANGUAGE: Record<string, ReadonlySet<string>[]> = {
  typescript: [JS_TS, REACT],
  tsx: [JS_TS, REACT],
  javascript: [JS_TS, REACT],
  jsx: [JS_TS, REACT],
  python: [PYTHON],
  go: [GO],
  rust: [RUST],
  ruby: [RUBY],
  java: [JAVA],
};

/**
 * True when `symbol` is a builtin, global, or stdlib member of `language` —
 * i.e. an edge target that lives outside any indexable user corpus.
 *
 * `language` is the language of the CALLING chunk (the callee's language is
 * unknowable before resolution). Unknown languages return false: we would
 * rather bucket an edge as `no_candidate_anywhere` than assert a reason we
 * cannot support.
 *
 * BARE targets only. A qualified target such as `Widget::get` or `Client.join`
 * has a user-owned namespace; matching its leaf against `get`/`join` would file
 * a real resolver miss under "that's just stdlib" and hide it. The namespace
 * never proves the symbol is external, so we decline to guess — a qualified
 * target that reaches this classifier belongs in `no_candidate_anywhere`.
 * The cost is small: real corpora emit builtins bare (`string`, `trim`, `map`),
 * because that is how the extractor tokenizes a method call.
 */
export function isLanguageBuiltin(symbol: string, language: string | null | undefined): boolean {
  if (!symbol || !language) return false;
  if (/::|\.|#/.test(symbol)) return false;
  const sets = BY_LANGUAGE[language];
  if (!sets) return false;
  return sets.some((s) => s.has(symbol));
}
