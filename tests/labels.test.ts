import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shortenLabel } from '../src/render/labels';

/** Names measured in the 27k-note test vault, where the median title is 37 characters. */
const REAL = [
  'Courses/Databases and Data Modeling/Resources/Slides/dmdb-fs25-relational-model-algebra.pdf',
  'Analysis of a Split-Split Plot One Whole-Plot Factor One Split-Plot Factor',
  'Polynomial Reduction 3-SAT to Subset Sum',
  'Grenzüberschreitender Warenverkehr Import von Lebensmitteln aus dem Ausland',
  '#area/project/phase-one-review',
  'Study Guide',
];

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

describe('Label shortening', () => {
  it('leaves a name alone that fits, and everything alone when the cap is off', () => {
    assert.equal(shortenLabel('Study Guide', 24), 'Study Guide');
    assert.equal(shortenLabel('a'.repeat(24), 24), 'a'.repeat(24));
    assert.equal(shortenLabel('a'.repeat(200), 0), 'a'.repeat(200));
    assert.equal(shortenLabel('a'.repeat(200), 1), 'a'.repeat(200));
  });

  it('cuts on a word when one ends close to the budget', () => {
    assert.equal(shortenLabel('Polynomial Reduction 3-SAT to Subset Sum', 24), 'Polynomial Reduction…');
  });

  it('hard-cuts rather than throw away most of the budget for a word', () => {
    // the only space inside the 23-character window sits at index 13
    assert.equal(shortenLabel('Analysis of a Split-Split Plot One', 24), 'Analysis of a Split-Spl…');
    assert.equal(shortenLabel('dmdb-fs25-relational-model-algebra.pdf', 24), 'dmdb-fs25-relational-mo…');
  });

  it('drops the path an unresolved link is labelled with', () => {
    assert.equal(
      shortenLabel('Courses/Databases/Resources/Slides/dmdb-fs25-relational-model-algebra.pdf', 24),
      'dmdb-fs25-relational-mo…',
    );
    // once the path is gone the name fits, so it needs no ellipsis
    assert.equal(shortenLabel('Courses/Math/linear-algebra-notes.md', 24), 'linear-algebra-notes.md');
  });

  it('keeps the nesting that makes a tag identifiable', () => {
    assert.equal(shortenLabel('#area/project/phase-one-review', 24), '#area/project/phase-one…');
  });

  it('never splits a surrogate pair', () => {
    const emoji = '\u{1F393}'.repeat(20);
    const short = shortenLabel(emoji, 24);
    assert.ok(!hasLoneSurrogate(short), `cut left half an emoji: ${JSON.stringify(short)}`);
    assert.ok(short.endsWith('…'));
  });

  it('never returns more characters than the cap allows', () => {
    for (const name of REAL) {
      for (const cap of [2, 6, 12, 24, 40, 80]) {
        const short = shortenLabel(name, cap);
        assert.ok(short.length <= cap, `${JSON.stringify(name)} at ${cap} drew ${short.length}`);
        assert.ok(!hasLoneSurrogate(short), `${JSON.stringify(name)} at ${cap} split a pair`);
      }
    }
  });
});
