import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatFixed, formatInt, getLocale, registerLocale, setLocale, t, tp } from '../src/i18n';
import en from '../src/locales/en';
import de from '../src/locales/de';
import es from '../src/locales/es';
import fr from '../src/locales/fr';
import itCatalogue from '../src/locales/it';
import ja from '../src/locales/ja';
import ko from '../src/locales/ko';
import pl from '../src/locales/pl';
import ptBr from '../src/locales/pt-br';
import ru from '../src/locales/ru';
import zh from '../src/locales/zh';
import type { PluralForms } from '../src/locales/types';

type Dictionary = Record<string, string | PluralForms>;

/** The shipped catalogues, read straight from the modules so test-only locales cannot leak in. */
const SHIPPED: Record<string, Dictionary> = {
  en: en,
  de: de,
  es: es,
  fr: fr,
  it: itCatalogue,
  ja: ja,
  ko: ko,
  pl: pl,
  'pt-br': ptBr,
  ru: ru,
  zh: zh,
};

/**
 * The keys a catalogue may legitimately leave identical to English. Measured, not
 * guessed: `label.clusterCount` is punctuation in every language, and "Tags" and
 * "Forces" are the real German, French and Portuguese words. Listed rather than
 * counted so the test also fails when a *different* key reverts to English.
 */
const IDENTICAL_ALLOWLIST: Record<string, string[]> = {
  de: ['panel.tags', 'label.clusterCount'],
  es: ['label.clusterCount'],
  fr: ['panel.forces', 'panel.tags', 'label.clusterCount'],
  it: ['label.clusterCount'],
  ja: ['label.clusterCount'],
  ko: ['label.clusterCount'],
  pl: ['label.clusterCount'],
  'pt-br': ['panel.tags', 'label.clusterCount'],
  ru: ['label.clusterCount'],
  zh: [],
};

const PLURAL_KEYS = [
  'card.noteCount',
  'card.internal.value',
  'status.nodes',
  'status.links',
  'status.folders',
  'status.folded',
  'label.clusterOverflow',
] as const;

const PLACEHOLDER = /\{(\w+)\}/g;

function forms(value: string | PluralForms): string[] {
  if (typeof value === 'string') return [value];
  return Object.values(value).filter((form): form is string => typeof form === 'string');
}

function placeholders(value: string | PluralForms): string[] {
  const found = new Set<string>();
  for (const text of forms(value)) {
    for (const match of text.matchAll(PLACEHOLDER)) found.add(match[1]);
  }
  return [...found].sort();
}

/** Every test shares one i18n module instance, so leave it on English. */
function withLocale(code: string, run: () => void): void {
  setLocale(code);
  try {
    run();
  } finally {
    setLocale('en');
  }
}

void describe('locale catalogues', () => {
  void it('carry exactly the English key set', () => {
    const expected = Object.keys(en).sort();
    for (const [code, dictionary] of Object.entries(SHIPPED)) {
      const actual = Object.keys(dictionary).sort();
      const missing = expected.filter((key) => !actual.includes(key));
      const extra = actual.filter((key) => !expected.includes(key));
      assert.deepEqual({ code, missing, extra }, { code, missing: [], extra: [] });
    }
  });

  void it('keep the same placeholders in every translation', () => {
    for (const [code, dictionary] of Object.entries(SHIPPED)) {
      for (const [key, expected] of Object.entries(en as Dictionary)) {
        assert.deepEqual(
          placeholders(dictionary[key]),
          placeholders(expected),
          `${code} "${key}" does not interpolate the same variables`,
        );
      }
    }
  });

  void it('do not leave whole catalogues untranslated', () => {
    for (const [code, dictionary] of Object.entries(SHIPPED)) {
      if (code === 'en') continue;
      const identical = Object.keys(en)
        .filter((key) => JSON.stringify(dictionary[key]) === JSON.stringify((en as Dictionary)[key]))
        .sort();
      assert.deepEqual(
        identical,
        [...(IDENTICAL_ALLOWLIST[code] ?? [])].sort(),
        `${code} differs from the strings it is allowed to leave in English`,
      );
    }
  });

  void it('cover every plural category the locale can select', () => {
    for (const [code, dictionary] of Object.entries(SHIPPED)) {
      const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
      assert.ok(categories.length > 0, `${code} reported no plural categories`);
      for (const key of PLURAL_KEYS) {
        const entry = dictionary[key];
        assert.equal(typeof entry, 'object', `${code} "${key}" is not a plural entry`);
        for (const category of categories) {
          assert.ok(
            typeof (entry as PluralForms)[category] === 'string',
            `${code} "${key}" has no "${category}" form`,
          );
        }
      }
    }
  });
});

void describe('locale resolution', () => {
  void it('defaults to English before anything is configured', () => {
    assert.equal(getLocale(), 'en');
    assert.equal(t('panel.filters'), 'Filters');
  });

  void it('falls back from a region to its base language', () => {
    withLocale('de-AT', () => {
      assert.equal(getLocale(), 'de');
      assert.equal(t('panel.filters'), 'Filter');
    });
    withLocale('en-GB', () => {
      assert.equal(getLocale(), 'en');
      assert.equal(t('panel.filters'), 'Filters');
    });
  });

  void it('accepts the codes Obsidian reports, whatever their case or separator', () => {
    withLocale('pt-BR', () => assert.equal(t('panel.filters'), 'Filtros'));
    withLocale('pt_BR', () => assert.equal(t('panel.filters'), 'Filtros'));
    withLocale('zh', () => assert.equal(t('panel.filters'), '筛选'));
  });

  void it('does not hand Traditional Chinese readers the Simplified catalogue', () => {
    for (const code of ['zh-TW', 'zh-HK', 'zh-Hant']) {
      withLocale(code, () => {
        assert.equal(getLocale(), 'en');
        assert.equal(t('panel.filters'), 'Filters');
      });
    }
    // ...while Simplified spellings do resolve to it
    for (const code of ['zh-cn', 'zh-Hans']) {
      withLocale(code, () => assert.equal(t('panel.filters'), '筛选'));
    }
  });

  void it('serves European Portuguese English rather than Brazilian', () => {
    withLocale('pt', () => assert.equal(t('panel.filters'), 'Filters'));
  });

  void it('falls back to English per key, not per dictionary', () => {
    registerLocale('test-partial', { 'label.vaultRoot': 'TEST ROOT' });
    withLocale('test-partial', () => {
      assert.equal(t('label.vaultRoot'), 'TEST ROOT');
      assert.equal(t('panel.filters'), 'Filters');
    });
  });

  void it('resolves an unknown language to English', () => {
    withLocale('xx-YY', () => {
      assert.equal(getLocale(), 'en');
      assert.equal(t('panel.filters'), 'Filters');
    });
  });
});

void describe('messages', () => {
  void it('interpolates named variables and leaves unknown ones alone', () => {
    assert.equal(t('view.graphOfFile', { name: 'Daily' }), 'Graph of Daily');
    assert.equal(t('view.graphOfFile', { wrong: 'x' }), 'Graph of {name}');
  });

  void it('keeps the embedded newline in the colour-swatch tooltip', () => {
    assert.equal(t('panel.swatchTooltip'), 'Click to change color\nDrag to reorder groups');
    withLocale('de', () => assert.ok(t('panel.swatchTooltip').includes('\n')));
  });

  void it('pluralises with English rules', () => {
    assert.equal(tp('status.nodes', 1), '1 node');
    assert.equal(tp('status.nodes', 0), '0 nodes');
    assert.equal(tp('status.nodes', 1546), '1,546 nodes');
    assert.equal(tp('card.noteCount', 1, { count: 'eine' }), 'eine note');
  });

  void it('picks the form the CLDR category asks for, not always "other"', () => {
    // Ukrainian shares Russian's integer rules and is not a shipped catalogue, so
    // the synthetic dictionary below is the only source these lookups can hit.
    registerLocale('uk', {
      'status.nodes': { one: 'O{count}', few: 'F{count}', many: 'M{count}', other: 'X{count}' },
    });
    withLocale('uk', () => {
      assert.equal(tp('status.nodes', 1), 'O1');
      assert.equal(tp('status.nodes', 2), 'F2');
      assert.equal(tp('status.nodes', 5), 'M5');
      assert.equal(tp('status.nodes', 11), 'M11');
      assert.equal(tp('status.nodes', 21), 'O21');
      assert.equal(tp('status.nodes', 22), 'F22');
      // a key the synthetic dictionary omits still reaches English
      assert.equal(t('panel.filters'), 'Filters');
    });
  });

  void it('pluralises Russian and Polish with their own catalogues', () => {
    for (const code of ['ru', 'pl'] as const) {
      const rules = new Intl.PluralRules(code);
      const counts = [0, 1, 2, 4, 5, 11, 12, 21, 22, 25, 100];
      const seen = new Set(counts.map((n) => rules.select(n)));
      // without this the test below would pass on a catalogue of four equal strings
      assert.ok(seen.size >= 3, `${code} only exercised ${[...seen].join('/')} over ${counts.join(', ')}`);
      const forms = SHIPPED[code]['status.links'] as PluralForms;
      withLocale(code, () => {
        for (const n of counts) {
          const category = rules.select(n);
          assert.equal(
            tp('status.links', n),
            forms[category]!.replace('{count}', formatInt(n)),
            `${code} status.links with ${n} should use the "${category}" form`,
          );
        }
      });
    }
  });

  void it('uses the single form for Japanese and Chinese', () => {
    withLocale('ja', () => {
      assert.equal(tp('status.nodes', 1), '1 ノード');
      assert.equal(tp('status.nodes', 5), '5 ノード');
    });
    withLocale('zh', () => {
      assert.equal(tp('status.nodes', 1), '1 个节点');
      assert.equal(tp('status.nodes', 5), '5 个节点');
    });
  });

  void it('counts zero as singular in French, as CLDR requires', () => {
    withLocale('fr', () => {
      assert.equal(tp('status.nodes', 0), '0 nœud');
      assert.equal(tp('status.nodes', 1), '1 nœud');
      assert.equal(tp('status.nodes', 2), '2 nœuds');
    });
  });
});

void describe('number formatting', () => {
  void it('groups with the locale separators', () => {
    withLocale('en', () => assert.equal(formatInt(1234567), '1,234,567'));
    withLocale('de', () => assert.equal(formatInt(1234567), '1.234.567'));
    withLocale('zh', () => assert.equal(formatInt(1234567), '1,234,567'));
  });

  void it('rounds counts before grouping them', () => {
    withLocale('en', () => {
      assert.equal(formatInt(1546.4), '1,546');
      assert.equal(formatInt(1546.6), '1,547');
    });
  });

  void it('formats fixed decimals with the locale separator', () => {
    withLocale('en', () => {
      assert.equal(formatFixed(0.43, 1), '0.4');
      assert.equal(formatFixed(42.2, 0), '42');
    });
    withLocale('de', () => {
      assert.equal(formatFixed(0.43, 1), '0,4');
      assert.equal(formatFixed(1234.5, 0), '1.235');
    });
  });

  void it('feeds the formatted number into plural messages', () => {
    withLocale('de', () => assert.equal(tp('status.nodes', 1546), '1.546 Knoten'));
  });
});
