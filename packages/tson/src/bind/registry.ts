/**
 * The two ways to build a {@link BindingRegistry} -- a fixed table, and a chain of fallbacks over
 * several tables. See `binding.ts`'s own doc on {@link BindingRegistry} for what it ports
 * (`DataNameBinder`) and why resolution stops at the authored `Binding` itself rather than
 * deriving one.
 */
import type { Binding, BindingRegistry } from './binding.js';

/** Build a {@link BindingRegistry} from a fixed table of bindings keyed by schema type name. */
export function registry(
  bindings: Readonly<Record<string, Binding<unknown>>>,
  options?: { readonly profile?: string },
): BindingRegistry {
  const table = new Map(Object.entries(bindings));
  return {
    get(schemaTypeName: string): Binding<unknown> | undefined {
      return table.get(schemaTypeName);
    },
    ...(options?.profile !== undefined ? { profile: options.profile } : {}),
  };
}

/**
 * Compose several registries into one that tries each in turn, first match wins -- the port of
 * `DefaultDataNameBinder` trying each of its configured packages in order.
 */
export function chain(...registries: readonly BindingRegistry[]): BindingRegistry {
  return {
    get(schemaTypeName: string): Binding<unknown> | undefined {
      for (const candidate of registries) {
        const found = candidate.get(schemaTypeName);
        if (found !== undefined) return found;
      }
      return undefined;
    },
  };
}
