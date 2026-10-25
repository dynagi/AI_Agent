/**
 * Whether a sentence about water, meals, medicine or money ASKS about the records (read) or TELLS AURA to add one
 * (write). A question must never change the user's records: "How many glasses of water have I had today?" used to
 * add a glass, because "had" + "glasses" matched the logging rule.
 *
 * Works for English, Roman-script Hinglish ("maine aaj kitne glass paani piye?") and Devanagari Hindi. Pure, so it is
 * unit tested (trackingIntent.test.ts).
 */

export type Topic = 'water' | 'meal' | 'medicine' | 'expense';
export type Mode = 'read' | 'write' | 'unclear';
export interface Tracking { topic: Topic; mode: Mode; count?: number }

const HINDI_NUM: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, saat: 7, aath: 8, nau: 9, das: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1,
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5,
};

/** Asks rather than tells: question words in English, Hinglish and Hindi, or a question mark. */
export function isQuestion(text: string): boolean {
  const t = norm(text);
  if (/\?\s*$/.test(text.trim())) return true;
  return /^(how|what|when|which|did|do|does|have|has|is|am|are|was|were|can|could|should|tell me|show me|check)\b/.test(t)
    || /\b(how (many|much|often)|kitn[aei]|kitne|kya maine|kya main|kya mai|maine kya|kab|kaun|kaunsi|kitni baar|enough|so far|till now|ab tak|aaj tak)\b/.test(t)
    || /(कितन[ाीे]|क्या|कब|कौन)/.test(text);
}

const TOPIC: [Topic, RegExp][] = [
  ['water', /\b(water|paani|pani|glass(es)?|bottles?)\b|पानी|गिलास/],
  ['medicine', /\b(medicines?|meds?|medication|tablets?|pills?|capsules?|dose|syrup|dawai|dawa|goli)\b|दवा|दवाई|गोली/],
  ['meal', /\b(breakfast|lunch|dinner|snack|meal|ate|eaten|khana|khaana|nashta)\b|खाना|नाश्ता/],
  ['expense', /\b(expenses?|spent|spend|spending|kharcha|kharch|kharche)\b|खर्च/],
];

// an explicit instruction or a first-person report of having done it
const WRITE = /\b(add|log|note|record|track|save|mark|put|likh|likho|jod|jodo|daal|daalo|add kar|kar de|kar do)\b|जोड़|लिख|\b(i (just |have |had )?(drank|drunk|had|took|taken|ate|finished|downed|spent)|i've (drunk|had|taken|eaten)|maine (abhi |aaj )?.*\b(piya|pi liya|pee liya|li|le li|liya|khaya|kha liya|kharch kiya|kharche))\b|मैंने/;

/** The tracking topic and whether it is a read or a write; null when the sentence isn't about tracking. */
export function trackingIntent(text: string): Tracking | null {
  const t = norm(text);
  const topic = TOPIC.find(([, re]) => re.test(t) || re.test(text))?.[0];
  if (!topic) return null;
  // a glass in a non-water sentence ("order glass bottles") is not about drinking water
  if (topic === 'water' && !/\b(water|paani|pani|drank|drink|drunk|piya|piye|pi liya)\b|पानी|पिया|पिए/.test(t + ' ' + text)) return null;
  const count = numberIn(t);
  if (isQuestion(text)) return { topic, mode: 'read', count };
  if (WRITE.test(t) || WRITE.test(text)) return { topic, mode: 'write', count };
  return { topic, mode: 'unclear', count };
}

export function numberIn(t: string): number | undefined {
  const d = t.match(/\d+(?:\.\d+)?/);
  if (d) return Number(d[0]);
  for (const w of t.split(/[\s,.!?]+/)) if (HINDI_NUM[w] !== undefined) return HINDI_NUM[w];
  return undefined;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/[.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
}
