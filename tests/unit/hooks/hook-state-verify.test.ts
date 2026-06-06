import { describe, it, expect } from 'vitest';
import { promptTriggersStateCheck } from '../../../src/hooks/hook-state-verify';

describe('promptTriggersStateCheck', () => {
  describe('positive matches — built-in keyword set', () => {
    const cases: Array<[string, string]> = [
      ['external surface — email', 'did you check my email this morning'],
      ['external surface — gmail (case insensitive)', 'pull up my GMAIL inbox'],
      ['external surface — drafts', 'what drafts are sitting in there right now'],
      ['external surface — calendar', "what's on the calendar today"],
      ['external surface — schedule', 'how does my schedule look thursday'],
      ['external surface — drive', 'open the marketing drive folder'],
      ['external surface — sheet', 'add a row to the tracker sheet'],
      ['external surface — spreadsheet', 'update the spreadsheet'],
      ['external surface — tracker', 'is the tracker up to date'],
      ['action verb — did', 'did you send the followup'],
      ['action verb — applied', "i applied to two roles already"],
      ['action verb — submitted', 'i submitted the application yesterday'],
      ['action verb — done', "the resignation letter is done"],
      ['state-change verb — label', 'label that thread urgent'],
      ['state-change verb — trash', 'trash the old draft'],
      ['outreach — follow-up (hyphenated)', 'draft the follow-up to Walsh'],
      ['outreach — followup (no hyphen)', 'draft the followup to Walsh'],
      ['outreach — letter', "the resignation letter should go today"],
      ['outreach — status', "what's the application status"],
    ];
    for (const [label, prompt] of cases) {
      it(label, () => expect(promptTriggersStateCheck(prompt)).toBe(true));
    }
  });

  describe('word-boundary discipline', () => {
    it('does NOT match "drove" when looking for "drive"', () => {
      expect(promptTriggersStateCheck('I drove home last night')).toBe(false);
    });
    it('does NOT match "deprive" when looking for "drive"', () => {
      expect(promptTriggersStateCheck('that would deprive us of context')).toBe(false);
    });
    it('does NOT match "metadata" when looking for "data" (data is not in our set anyway)', () => {
      // safety check — we don't WANT to trigger on substrings of unrelated words
      expect(promptTriggersStateCheck('check the metadata')).toBe(false);
    });
    it('does match "calendar." with trailing punctuation', () => {
      expect(promptTriggersStateCheck('look at the calendar.')).toBe(true);
    });
    it('does match keyword at start of prompt', () => {
      expect(promptTriggersStateCheck('email — anything new today?')).toBe(true);
    });
    it('does match keyword at end of prompt', () => {
      expect(promptTriggersStateCheck('anything new in email')).toBe(true);
    });
  });

  describe('negative cases — prompts that should NOT trigger', () => {
    it('empty string', () => expect(promptTriggersStateCheck('')).toBe(false));
    it('chitchat with no state words', () => {
      expect(promptTriggersStateCheck('hi boss, how are you')).toBe(false);
    });
    it('abstract question with no verifiable state', () => {
      expect(promptTriggersStateCheck('what should I focus on this week')).toBe(false);
    });
    it('keyword as substring of unrelated word', () => {
      // "doing" contains "do" but not the standalone word "did"
      expect(promptTriggersStateCheck('what are you doing')).toBe(false);
    });
  });

  describe('extras file — runtime extension', () => {
    it('matches a keyword supplied via the extras list', () => {
      expect(promptTriggersStateCheck('did you process the contract', ['contract'])).toBe(true);
    });
    it('extras do NOT override word-boundary discipline', () => {
      expect(promptTriggersStateCheck('subcontractor work', ['contract'])).toBe(false);
    });
    it('empty extras list is a no-op', () => {
      expect(promptTriggersStateCheck('random chitchat', [])).toBe(false);
    });
  });
});
