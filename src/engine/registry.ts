/**
 * A lookup table that holds only the names put into it.
 *
 * A plain `{}` also answers to "constructor", "toString", "__proto__" and the
 * rest of Object.prototype, so `name in table` and `table[name]` say yes to
 * them. A name that arrives off the wire, out of a level file or from the URL
 * could then pull a function out where a spec was expected and crash whatever
 * reads it next. A table with no prototype has nothing to inherit, so every
 * lookup is either a real entry or undefined.
 */
export function registry<T>(entries: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}
