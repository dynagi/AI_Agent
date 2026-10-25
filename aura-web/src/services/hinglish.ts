/**
 * Hinglish orders rewritten as English ones for the app's order rules ("Mere liye doodh order kar de" -> "order milk"),
 * keeping products and quantities as said. The server (hinglish.py) and the phone (Hinglish.java) have the same rules
 * for their own commands. Returns the text unchanged when no rule applies.
 */
const GROCERY: Record<string, string> = {
  doodh: 'milk', dudh: 'milk', anda: 'eggs', ande: 'eggs', chini: 'sugar', cheeni: 'sugar', chawal: 'rice', aata: 'atta',
  dahi: 'curd', makhan: 'butter', namak: 'salt', pyaz: 'onion', pyaaz: 'onion', aloo: 'potato', tamatar: 'tomato',
  sabzi: 'vegetables', kela: 'banana', kele: 'banana', seb: 'apple',
};
const V = '(?:kar(?:\\s?(?:o|do|de|dijiye))?|kardo|karde)';
const FILLER = /^(?:hey aura,?\s+|aura,?\s+)?(?:please\s+|zara\s+|jaldi\s+)?(?:mere liye\s+|mujhe\s+|hamare liye\s+)?/i;
const ORDER = new RegExp(`^(.+?)\\s+(?:order\\s+${V}|mangwa(?:\\s?(?:o|do|de))?|manga(?:\\s?(?:o|do|de))?|cart me(?:in)? daal(?:\\s?(?:o|do|de))?)$`, 'i');
const FROM_STORE = /^(blinkit|zepto|swiggy|instamart|zomato|bigbasket|amazon|flipkart)\s+(?:se|par|pe)\s+(.+)$/i;

function items(s: string): string {
  let out = ` ${s} `;
  for (const [hi, en] of Object.entries(GROCERY)) out = out.replace(new RegExp(`\\b${hi}\\b`, 'gi'), en);
  return out.replace(/\s+\b(ka|ki|ke)\b\s+/gi, ' ').replace(/\s+\b(aur|or)\b\s+/gi, ' and ').trim();
}

export function hinglishToEnglish(text: string): string {
  let body = text.trim().replace(/[?.!]+$/, '').replace(FILLER, '');
  let store = '';
  const named = body.match(FROM_STORE);               // "Blinkit se doodh order kar do": the store moves to the end
  if (named) { store = ` from ${named[1]}`; body = named[2]; }
  const m = body.match(ORDER);
  return m ? `order ${items(m[1])}${store}` : text;
}
