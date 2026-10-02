// node:sqlite still prints an ExperimentalWarning on load; it is expected here, so hide just that one.
const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (/SQLite is an experimental feature/.test(text ?? '')) return;
  emit(warning, ...rest);
}) as typeof process.emitWarning;
