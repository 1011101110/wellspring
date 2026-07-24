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

  it('flags the V5-hardened English crisis / hopelessness phrasings', () => {
    for (const line of [
      'there is no point in living anymore',
      "I can't take it anymore",
      'I just want to disappear',
      'I have nothing to live for',
      'everyone would be better off without me',
      "I don't want to wake up tomorrow",
      'I keep thinking about hurting myself',
      'I wish I were dead',
      'I want to end it all tonight',
    ]) {
      expect(detectSpokenDistress(line)).toBe(true);
    }
  });

  it('flags the V5-hardened cues across the other five content languages', () => {
    // Spanish
    expect(detectSpokenDistress('ya no quiero vivir')).toBe(true);
    expect(detectSpokenDistress('quiero acabar con mi vida')).toBe(true);
    // French
    expect(detectSpokenDistress('je ne veux plus vivre')).toBe(true);
    expect(detectSpokenDistress('je veux en finir')).toBe(true);
    // German
    expect(detectSpokenDistress('ich will sterben')).toBe(true);
    expect(detectSpokenDistress('ich will mir das leben nehmen')).toBe(true);
    // Portuguese
    expect(detectSpokenDistress('não quero mais viver')).toBe(true);
    expect(detectSpokenDistress('quero acabar com a minha vida')).toBe(true);
    // Simplified Chinese
    expect(detectSpokenDistress('我不想活了')).toBe(true);
    expect(detectSpokenDistress('我活不下去了')).toBe(true);
  });

  it('still does NOT flag ordinary hard days after the V5 broadening (no over-firing)', () => {
    for (const line of [
      'this week has been really draining and I need rest',
      'I feel disappointed about how the meeting went',
      'I am worried about my presentation tomorrow',
      'money has been tight and it is stressful',
    ]) {
      expect(detectSpokenDistress(line)).toBe(false);
    }
  });
});
