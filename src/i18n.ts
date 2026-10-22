/** Locale resolution and message lookup.
 *
 *  This module deliberately has no `obsidian` import. `src/graph/build.ts` needs the
 *  canvas cluster labels translated, and `tests/run.mjs` bundles that file for node
 *  with only `node:*` marked external - a runtime `obsidian` import reachable from
 *  here would break the test bundle. `src/main.ts` reads the app language and
 *  injects it with `setLocale()`; until that runs, everything resolves to English.
 */

import en, { type Messages } from "./locales/en";
import type { PluralForms } from "./locales/types";
import de from "./locales/de";
import es from "./locales/es";
import fr from "./locales/fr";
import it from "./locales/it";
import ja from "./locales/ja";
import ko from "./locales/ko";
import pl from "./locales/pl";
import ptBr from "./locales/pt-br";
import ru from "./locales/ru";
import zh from "./locales/zh";

type Dictionary = Readonly<Partial<Messages>>;
type Vars = Record<string, string | number>;

/** Keys whose English value is a plain string; only these are valid for `t()`. */
export type StringKey = {
  [K in keyof Messages]: Messages[K] extends string ? K : never;
}[keyof Messages];

/** Keys whose English value carries plural forms; only these are valid for `tp()`. */
export type PluralKey = {
  [K in keyof Messages]: Messages[K] extends PluralForms ? K : never;
}[keyof Messages];

const CATALOGUES: Record<string, Dictionary> = {
  en,
  de,
  es,
  fr,
  it,
  ja,
  ko,
  pl,
  ru,
  zh,
  "pt-br": ptBr,
};

/** Dictionaries we ship, in the order `setLocale` prefers them. */
export const LOCALES: readonly string[] = Object.keys(CATALOGUES);

const PLACEHOLDER = /\{(\w+)\}/g;

let lang = "en";
/** Most specific first; `en` is always last, so every key resolves. */
let chain: Dictionary[] = [en];
let plurals = new Intl.PluralRules("en");
let integers = new Intl.NumberFormat("en");
const fixedDigits = new Map<number, Intl.NumberFormat>();

function normalize(code: string): string {
  return code.toLowerCase().replace(/_/g, "-");
}

/**
 * The language to fall back to when a region-qualified code has no dictionary of
 * its own: `en-GB` reads English, `de-AT` reads German.
 *
 * Chinese is the exception. Obsidian codes Simplified Chinese as a bare `zh`, so
 * letting `zh-tw` or `zh-hant` fall back to it would hand Traditional Chinese
 * readers the wrong script; they get English instead.
 */
function baseOf(code: string): string | null {
  const base = code.split("-")[0];
  if (base === code) return null;
  if (base === "zh" && !/^(zh|zh-cn|zh-sg|zh-hans(-\w+)?)$/.test(code)) return null;
  return base;
}

/** Point every lookup at `code`. Idempotent, and safe to call once per `onload`. */
export function setLocale(code: string): void {
  const requested = normalize(code);
  const candidates = [requested];
  const base = baseOf(requested);
  if (base !== null) candidates.push(base);

  lang = candidates.find((candidate) => CATALOGUES[candidate] !== undefined) ?? "en";
  chain = [];
  for (const candidate of candidates) {
    const dictionary = CATALOGUES[candidate];
    if (dictionary && !chain.includes(dictionary)) chain.push(dictionary);
  }
  if (!chain.includes(en)) chain.push(en);

  try {
    plurals = new Intl.PluralRules(lang);
    integers = new Intl.NumberFormat(lang);
  } catch {
    // an ICU build that rejects the tag still has to render something
    plurals = new Intl.PluralRules("en");
    integers = new Intl.NumberFormat("en");
  }
  fixedDigits.clear();
}

/** The code lookups and number formats currently resolve against. */
export function getLocale(): string {
  return lang;
}

/**
 * Add or replace a dictionary - the hook the tests use to exercise plural rules
 * without depending on translation wording, and the seam a future partial
 * catalogue would come in through. Call `setLocale` afterwards to pick it up.
 */
export function registerLocale(code: string, dictionary: Partial<Messages>): void {
  const normalized = normalize(code);
  CATALOGUES[normalized] = dictionary;
  if (normalized === lang) setLocale(normalized);
}

function lookup(key: keyof Messages): string | PluralForms | undefined {
  for (const dictionary of chain) {
    const value = dictionary[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function fill(template: string, vars?: Vars): string {
  if (vars === undefined) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** A plain message. Unknown keys come back as the key itself rather than throwing. */
export function t(key: StringKey, vars?: Vars): string {
  const value = lookup(key);
  return fill(typeof value === "string" ? value : key, vars);
}

/**
 * A message with plural forms, chosen by `Intl.PluralRules` for the active locale.
 * `{count}` is filled with the locale-formatted number unless the caller overrides it.
 */
export function tp(key: PluralKey, n: number, vars?: Vars): string {
  const merged: Vars = { count: formatInt(n), ...vars };
  const category = plurals.select(n);
  for (const dictionary of chain) {
    const value = dictionary[key];
    if (value === undefined || typeof value === "string") continue;
    const form = value[category] ?? value.other;
    if (form !== undefined) return fill(form, merged);
  }
  return fill(key, merged);
}

/** Grouped with the locale's separators, no decimals: `1546` -> `1.546` in German. */
export function formatInt(n: number): string {
  return integers.format(Math.round(n));
}

/** Grouped, with exactly `digits` decimals: `0.43` -> `0,4` in German at one digit. */
export function formatFixed(n: number, digits: number): string {
  let format = fixedDigits.get(digits);
  if (!format) {
    try {
      format = new Intl.NumberFormat(lang, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    } catch {
      return n.toFixed(digits);
    }
    fixedDigits.set(digits, format);
  }
  return format.format(n);
}
