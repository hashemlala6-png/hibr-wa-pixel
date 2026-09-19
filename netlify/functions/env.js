function env(name) {
  try {
    const value = process?.env?.[name];
    if (value !== undefined && value !== null && String(value).length) return String(value);
  } catch {}
  try {
    const value = globalThis.Netlify?.env?.get?.(name);
    return value === undefined || value === null ? '' : String(value);
  } catch {
    return '';
  }
}

module.exports = { env };
