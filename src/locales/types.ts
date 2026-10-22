/** Shapes shared by every locale catalogue. */

/**
 * The CLDR categories a language can need. `one` and `other` are required so the
 * type stays honest for English-like languages; `ru` and `pl` also fill `few` and
 * `many`, and `ja` / `zh` / `ko` repeat `other` in `one` because `satisfies` asks
 * for it even though `Intl.PluralRules` never selects it there.
 */
export type PluralForms = { one: string; other: string } & Partial<
  Record<"zero" | "two" | "few" | "many", string>
>;

export type MessageValue = string | PluralForms;
