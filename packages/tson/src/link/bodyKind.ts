/**
 * The resolved-value shapes a `link/` check switches over. Every {@link Top} member but the held
 * `TemplateBody` carries a `kind` literal, so an ordinary `switch (body.kind)` over a
 * {@link NonHeldTop} is exhaustive -- the namespace value of a meta layer's vocabulary included,
 * which takes its own explicit arm wherever a check meets one.
 */
import type { TemplateBody } from '../schema/meta/bodies.js';
import type { Top } from '../schema/meta/typedef.js';

/** Every {@link Top} member but the held template body, which carries no `kind`. */
export type NonHeldTop = Exclude<Top, TemplateBody>;
