/**
 * The resolved-value shapes a `link/` check switches over. Every {@link Top} member carries a `kind` literal, so
 * an ordinary `switch (body.kind)` is exhaustive.
 */
import type { Top } from '../schema/meta/typedef.js';

/** Every {@link Top} member. */
export type NonHeldTop = Top;
