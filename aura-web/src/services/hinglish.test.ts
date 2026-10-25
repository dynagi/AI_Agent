import { describe, expect, it } from 'vitest';
import { hinglishToEnglish } from './hinglish';
import { parseOrderRequest } from './orderIntent';

describe('Hinglish orders', () => {
  it.each([
    ['Mere liye doodh order kar de.', 'order milk'],
    ['Aura, 2 packet doodh mangwa do', 'order 2 packet milk'],
    ['Blinkit se doodh order kar do', 'order milk from Blinkit'],
    ['ande aur bread cart mein daal do', 'order eggs and bread'],
  ])('%s -> %s', (said, english) => expect(hinglishToEnglish(said)).toBe(english));

  it('the result is an order the app understands', () => {
    expect(parseOrderRequest(hinglishToEnglish('Mere liye doodh order kar de'))?.items[0].raw).toMatch(/milk/);
    expect(parseOrderRequest(hinglishToEnglish('Blinkit se doodh order kar do'))?.platform).toBe('blinkit');
  });

  it('English and questions are left alone', () => {
    expect(hinglishToEnglish('order milk from blinkit')).toBe('order milk from blinkit');
    expect(hinglishToEnglish('maine last time kya order kiya tha')).toBe('maine last time kya order kiya tha');
  });
});
