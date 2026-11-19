/**
 * The kernel's machinery's names (Part 2 §9, §2.2.3). The kernel (`meta.tn`) keeps its root to the
 * vocabulary an author writes (`text`, `integer`, `doc`, `enum`, `set`, ...) and declares everything
 * else as a member of one of six open schema maps nested in its root, each named by its path from the
 * root (§5.12): the type system under {@link META_MAP} (`meta.record`, `meta.identifier`,
 * `meta.type_ref`), the datatype properties under {@link ATOM_MAP} (`atom.ordering`,
 * `atom.specification`), and the atom constructors under {@link NUMERIC_MAP}, {@link UNICODE_MAP},
 * {@link NET_MAP} and {@link BINARY_MAP} (`numeric.integer_type`, `unicode.text_type`, `net.iri_type`,
 * `binary.bytes_type`). The data-format libraries add members to the same maps and declare a map of
 * their own, {@link TEMPORAL_MAP}.
 *
 * This is the one place a qualified kernel name is spelled in code: a literal naming a member is its
 * path, {@link metaName}`('record')` for `"meta.record"`, and one naming a root entry is bare
 * (`"text"`). A member's identity is its declaring document and its path, so a path is the kernel's
 * only where the kernel declares it.
 */

/** The schema map holding the type system. */
export const META_MAP = 'meta';
/** The schema map holding the datatype properties and the `atom.specification` mixin. */
export const ATOM_MAP = 'atom';
/** The schema map holding the integer constructor, which `numeric.tn` adds to. */
export const NUMERIC_MAP = 'numeric';
/** The schema map holding the text, identifier and regex constructors. */
export const UNICODE_MAP = 'unicode';
/** The schema map holding the IRI constructor, which `net.tn` adds to. */
export const NET_MAP = 'net';
/** The schema map holding the octet-sequence constructor. */
export const BINARY_MAP = 'binary';
/** The schema map `temporal.tn` declares. */
export const TEMPORAL_MAP = 'temporal';

/** The six maps the kernel nests in its root, in the order its document declares them. */
export const KERNEL_MAPS: readonly string[] = [
  NUMERIC_MAP,
  UNICODE_MAP,
  NET_MAP,
  ATOM_MAP,
  META_MAP,
  BINARY_MAP,
];

/** The thirteen names the kernel's root holds (§2.2.3, change log #15). */
export const KERNEL_ROOT_NAMES: readonly string[] = [
  'void',
  'boolean',
  'integer',
  'int64',
  'text',
  'bytes',
  'iri',
  'iri_reference',
  'regex',
  'doc',
  'enum',
  'set',
  'schema',
];

/** A path under {@link META_MAP}: its first segment and its dot. */
export const META_PREFIX = `${META_MAP}.`;

/** The path of the type system's member `member`: `record` gives `meta.record`. */
export function metaName(member: string): string {
  return META_PREFIX + member;
}

/** The path of `member` under the kernel's map `map`: `unicode.text_type`. */
export function kernelName(map: string, member: string): string {
  return `${map}.${member}`;
}

/** Whether `name` is the path of a member of {@link META_MAP}: `meta.record`, not `meta.a.b`. */
export function isMetaPath(name: string): boolean {
  return name.startsWith(META_PREFIX) && !name.includes('.', META_PREFIX.length);
}

/** The member's own name where `name` is a path under {@link META_MAP}, else `name`. */
export function metaMember(name: string): string {
  return isMetaPath(name) ? name.slice(META_PREFIX.length) : name;
}

/** The kernel's `schema` namespace type, the one a schema map is a value of (§4.1). */
export const SCHEMA = metaName('schema');
/** The kernel's `field_map`, the ordered map type a record's fields are a value of (§5.2). */
export const FIELD_MAP = metaName('field_map');
/** The kernel's `record_template_field_map`, the ordered map type a record template's fields are a value of (§5.10). */
export const RECORD_TEMPLATE_FIELD_MAP = metaName('record_template_field_map');
/** The kernel's `field_name`, an identifier: a record's name type where nothing states one (§5.2). */
export const FIELD_NAME = metaName('field_name');
/** The kernel's `application` annotation, derived and never author-written (§8.2). */
export const APPLICATION_ANNOTATION = metaName('application');
/** The kernel's `synthetic` annotation: the key of a form no author named (§8.2). */
export const SYNTHETIC_ANNOTATION = metaName('synthetic');
/** The kernel's `disjoint` annotation, the author's assertion that a choice's variants are disjoint (§5.4). */
export const DISJOINT_ANNOTATION = metaName('disjoint');
/** The tag of a schema document's root and of a schema map nested as an entry: an alias of {@link SCHEMA} (§2.1). */
export const SCHEMA_TAG = 'schema';
