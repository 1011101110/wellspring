import { describe, expect, it } from 'vitest';
import { detectSpokenDistress } from '../../../src/services/stage/distressHeuristics.js';

describe('detectSpokenDistress (EPIC V #360 / V2 #363, epic §4)', () => {
  it('flags explicit English self-harm / suicidal-ideation cues', () => {
    for (const line of [
      'I want to die',
      'I keep thinking about killing myself',
      "honestly I don't want to be here anymore",
      "I've been having suicidal thoughts",
      'I want to hurt myself',
    ]) {
      expect(detectSpokenDistress(line)).toBe(true);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(detectSpokenDistress('  I   WANT   TO   DIE  ')).toBe(true);
  });

  it('flags high-confidence cues in the other content languages', () => {
    expect(detectSpokenDistress('quiero morir')).toBe(true); // es
    expect(detectSpokenDistress('je veux mourir')).toBe(true); // fr
    expect(detectSpokenDistress('ich will mich umbringen')).toBe(true); // de
    expect(detectSpokenDistress('eu quero morrer')).toBe(true); // pt
    expect(detectSpokenDistress('我想死')).toBe(true); // zh
  });

  it('does NOT flag ordinary sadness / anxiety (those get a normal grounded response)', () => {
    for (const line of [
      "I'm anxious about a hard conversation with my dad",
      'I am so grateful for my family today',
      'work has been exhausting and I feel stretched thin',
      'I feel a bit lost lately',
    ]) {
      expect(detectSpokenDistress(line)).toBe(false);
    }
  });

  it('never flags an empty/whitespace transcript', () => {
    expect(detectSpokenDistress('')).toBe(false);
    expect(detectSpokenDistress('   ')).toBe(false);
  });
});
