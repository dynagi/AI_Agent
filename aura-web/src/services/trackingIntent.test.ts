import { describe, expect, it } from 'vitest';
import { isQuestion, trackingIntent } from './trackingIntent';

describe('a question never becomes a record', () => {
  it.each([
    ['How many glasses of water have I drunk today?', 'water'],
    ['How many glasses of water have I had today', 'water'],        // the reported bug: "had" + "glasses" added one
    ['Did I drink enough water today', 'water'],
    ['How much water have I logged', 'water'],
    ['Maine aaj kitne glass paani piye?', 'water'],
    ['maine aaj kitne glass paani piye', 'water'],                  // no question mark from speech recognition
    ['मैंने आज कितने गिलास पानी पिए', 'water'],
    ['Maine aaj kitni medicines li hain', 'medicine'],
    ['Did I take my medicine today', 'medicine'],
    ['What did I have for lunch', 'meal'],
    ['Aaj maine kitna kharcha kiya', 'expense'],
    ['Show me my expenses today', 'expense'],
  ])('%s -> read', (text, topic) => {
    expect(trackingIntent(text)).toMatchObject({ topic, mode: 'read' });
  });
});

describe('explicit logging is a write', () => {
  it.each([
    ['Add one glass of water', 'water', 1],
    ['I just drank a glass of water, log it', 'water', 1],
    ['I drank two glasses of water', 'water', 2],
    ['Maine abhi ek glass paani piya, ise add kar de', 'water', 1],
    ['Aura, mere liye ek glass paani add kar', 'water', 1],
    ['I took my medicine', 'medicine', undefined],
    ['I had dal rice for lunch', 'meal', undefined],
  ])('%s -> write', (text, topic, count) => {
    expect(trackingIntent(text)).toMatchObject({ topic, mode: 'write' });
    if (count !== undefined) expect(trackingIntent(text)?.count).toBe(count);
  });
});

describe('unrelated or unclear', () => {
  it('a word alone does not log', () => {
    expect(trackingIntent('water')).toMatchObject({ topic: 'water', mode: 'unclear' });
  });
  it('other sentences are not tracking', () => {
    expect(trackingIntent('order milk from blinkit')).toBeNull();
    expect(trackingIntent('play a song on youtube')).toBeNull();
  });
  it('question detection', () => {
    expect(isQuestion('kya maine aaj dawai li')).toBe(true);
    expect(isQuestion('I drank water')).toBe(false);
  });
});
