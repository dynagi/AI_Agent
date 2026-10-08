import { useMemo, useRef, useState } from 'react';
import {
  Plane, BedDouble, ArrowLeftRight, Users, Search, Compass, ShieldCheck, Sparkles, ClipboardList, Map, ChevronRight, CalendarDays, BadgeCheck, ArrowUpDown, ExternalLink, MapPinned, ThumbsUp, ThumbsDown,
} from 'lucide-react';
import { Hud, PageHero, NeonButton, NeonTabs, IconBox, Drawer, FuturisticModal, SyncStatus, toast, type Tone } from '../components/aura';
import { AICommandPanel, confirmActions, domainAsk, type AIReply } from '../components/ai';
import { aura } from '../services/aura';
import { apiGet, apiSend } from '../services/api';
import { bookingsStore, tripsStore, travelFeedbackStore } from '../state/stores';
import { uid } from '../state/store';
import type { HotelResult, FlightResult } from '../data/trips';

const MODES = ['Flights', 'Hotels'] as const;
type Mode = (typeof MODES)[number];
const modeIcon = { Flights: Plane, Hotels: BedDouble };

const AIRPORTS = [
  'Pune (PNQ)', 'Mumbai (BOM)', 'Delhi (DEL)', 'Bengaluru (BLR)', 'Hyderabad (HYD)', 'Chennai (MAA)', 'Kolkata (CCU)', 'Goa (GOI)', 'Ahmedabad (AMD)', 'Kochi (COK)',
  'Jaipur (JAI)', 'Lucknow (LKO)', 'Nagpur (NAG)', 'Indore (IDR)', 'Chandigarh (IXC)', 'Srinagar (SXR)', 'Dubai (DXB)', 'Singapore (SIN)', 'London (LHR)', 'Bangkok (BKK)',
];

const money = (n: number, currency = 'INR') => { try { return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n); } catch { return `${currency} ${n}`; } };
const isoIn = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
/** Accepts "Pune (PNQ)" or a bare 3-letter IATA code. */
const iata = (v: string) => (v.match(/\(([A-Za-z]{3})\)/)?.[1] ?? (/^[A-Za-z]{3}$/.test(v.trim()) ? v.trim() : '')).toUpperCase();
const place = (v: string) => v.replace(/\s*\(.*\)/, '').trim();
const hhmm = (s: string) => s.split(' ')[1] ?? s;
const dur = (m?: number) => (m ? `${Math.floor(m / 60)}h ${m % 60}m` : '');

interface ApiFlight { price: number; currency: string; origin: string; destination: string; departureAt: string; arrivalAt: string; airline?: string; flightNumber?: string; duration?: number; stops: number; bookingUrl?: string }
interface ApiHotel { name: string; pricePerNight?: number | null; totalPrice?: number | null; currency: string; hotelClass?: string; rating?: number; link?: string }

const toFlight = (f: ApiFlight, i: number): FlightResult => ({
  id: `f${i}`, airline: f.airline ?? 'Airline', code: f.flightNumber ?? '', dep: hhmm(f.departureAt), arr: hhmm(f.arrivalAt), dur: dur(f.duration),
  price: f.price, currency: f.currency, stops: f.stops === 0 ? 'Non-stop' : `${f.stops} stop${f.stops > 1 ? 's' : ''}`, link: f.bookingUrl,
});
const toHotel = (h: ApiHotel, i: number): HotelResult => ({
  id: `h${i}`, name: h.name, perNight: h.pricePerNight ?? undefined, total: h.totalPrice ?? undefined, currency: h.currency, stars: h.hotelClass, rating: h.rating, link: h.link,
});

type Row = { id: string; title: string; sub: string; meta: string; price: number; currency: string; per: string; link?: string; mode: Mode; provider?: string; rating?: number };

export default function Travel() {
  const bookings = bookingsStore.use();
  const trips = tripsStore.use();
  const [mode, setMode] = useState<Mode>('Flights');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dep, setDep] = useState(isoIn(7));
  const [ret, setRet] = useState(isoIn(11));
  const [pax, setPax] = useState(1);
  const [paxOpen, setPaxOpen] = useState(false);
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' | 'error'; error: string }>({ state: 'idle', error: '' });
  const [results, setResults] = useState<Row[] | null>(null);
  const [searchedFor, setSearchedFor] = useState('');
  const [sortBy, setSortBy] = useState<'price' | 'name'>('price');
  const [book, setBook] = useState<{ title: string; lines: string[]; link?: string } | null>(null);
  const [drawer, setDrawer] = useState<'bookings' | 'itinerary' | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => results && [...results].sort((a, b) => (sortBy === 'price' ? a.price - b.price : a.title.localeCompare(b.title))), [results, sortBy]);

  const search = async () => {
    setResults(null);
    if (mode === 'Flights') {
      const o = iata(from); const d = iata(to);
      if (!o || !d) { toast('Pick both airports from the list, or type 3-letter codes such as PNQ and GOI.'); return; }
      setStatus({ state: 'loading', error: '' });
      try {
        const res = await apiGet<{ data: ApiFlight[] }>('/travel/flights', { origin: o, destination: d, departureDate: dep, adults: pax });
        const rows: Row[] = res.data.map(toFlight).map((f) => ({ id: f.id, title: `${f.airline} ${f.code}`.trim(), sub: `${f.dep} → ${f.arr}${f.dur ? ` · ${f.dur}` : ''}`, meta: f.stops, price: f.price, currency: f.currency, per: 'per person', link: f.link, mode: 'Flights' as const, provider: f.airline }));
        setResults(rows);
        setSearchedFor(`${place(from) || o} → ${place(to) || d}`);
        setStatus({ state: 'idle', error: '' });
        void rankResults(rows);
      } catch (e) {
        setStatus({ state: 'error', error: e instanceof Error ? e.message : 'Flight search failed' });
      }
      return;
    }
    if (!to.trim()) { toast('Enter a city or place.'); return; }
    if (ret <= dep) { toast('Check-out must be after check-in.'); return; }
    setStatus({ state: 'loading', error: '' });
    try {
      const res = await apiGet<{ data: ApiHotel[] }>('/travel/hotels', { destination: place(to), checkInDate: dep, checkOutDate: ret, adults: pax });
      const rows: Row[] = res.data.map(toHotel).map((h) => ({ id: h.id, title: h.name, sub: [h.stars, h.rating ? `${h.rating} ★` : ''].filter(Boolean).join(' · '), meta: h.perNight ? `${money(h.perNight, h.currency)} / night` : '', price: h.total ?? h.perNight ?? 0, currency: h.currency, per: 'total stay', link: h.link, mode: 'Hotels' as const, rating: h.rating })).filter((r) => r.price > 0);
      setResults(rows);
      setSearchedFor(place(to));
      setStatus({ state: 'idle', error: '' });
      void rankResults(rows);
    } catch (e) {
      setStatus({ state: 'error', error: e instanceof Error ? e.message : 'Hotel search failed' });
    }
  };

  /** Re-orders results by predicted interest once the AI service responds — falls back silently (keeps price order) if unavailable or untrained. */
  const rankResults = async (rows: Row[]) => {
    if (!rows.length) return;
    try {
      const res = await apiSend<{ data: Row[] }>('POST', '/travel/suggestions', {
        items: rows.map((r) => ({ ...r, name: r.title, category: r.mode === 'Flights' ? 'flight' : 'hotel' })),
      });
      setResults((current) => (current && current[0]?.mode === rows[0].mode ? res.data : current));
    } catch {
      /* ranking is a nice-to-have on top of live price search */
    }
  };

  /** Snapshots an interested/not-interested reaction for the daily travel interest model. */
  const recordFeedback = (r: Row, interested: boolean) => {
    travelFeedbackStore.set((fb) => [
      ...fb,
      { id: uid('tfb'), itemId: r.id, interested, mode: r.mode === 'Flights' ? 'flight' : 'hotel', title: r.title, price: r.price, currency: r.currency, provider: r.provider, rating: r.rating, createdAt: new Date().toISOString() },
    ]);
  };

  const context = () => JSON.stringify({
    today: isoIn(0), lastSearch: searchedFor, mode,
    topResults: (sorted ?? []).slice(0, 6).map((r) => ({ title: r.title, price: r.price, currency: r.currency, info: r.sub })),
    savedBookings: bookings.map((b) => ({ title: b.title, detail: b.detail, status: b.status })),
  });
  const chat = domainAsk('travel', context);
  const ai = async (p: string): Promise<AIReply> => {
    const reply = await aura.chat(`[travel] ${p}`, context());
    const lines = reply.text.split('\n').map((l) => l.replace(/^[-*•\d.\s]+/, '').trim()).filter((l) => l.length > 3);
    return {
      text: reply.text,
      actions: lines.length >= 3 ? confirmActions('Save as itinerary', () => { tripsStore.set((t) => [...t, { id: uid('trip'), destination: p.slice(0, 60), startDate: dep, endDate: ret, days: [{ day: 'AURA plan', items: lines.slice(0, 40) }] }]); setDrawer('itinerary'); return 'Saved to your itineraries. Bookings still need your approval.'; }) : undefined,
    };
  };
  void chat;

  const swap = () => { setFrom(to); setTo(from); };
  const latest = bookings[bookings.length - 1];
  const nights = Math.max(1, Math.round((new Date(ret).getTime() - new Date(dep).getTime()) / 86_400_000));

  return (
    <div className="module">
      <div className="main">
        <PageHero title={<>Travel <span className="grad">Smarter</span></>} lead="Compare live flight and hotel prices, then save your plans with AURA." image="/aura/hero-travel.jpg" imageWidth="48%"
          quote="AURA turns travel plans into unforgettable experiences."
          feats={[
            { icon: Plane, title: 'Live fares', sub: 'Lowest price first' },
            { icon: BedDouble, title: 'Hotel prices', sub: 'Compare stays', tone: 'violet' },
            { icon: Compass, title: 'AI itineraries', sub: 'Save time and explore more', tone: 'cyan' },
            { icon: ShieldCheck, title: 'You approve', sub: 'Nothing is booked for you', tone: 'teal' },
          ]} />

        <div ref={formRef}><NeonTabs tabs={MODES} value={mode} onChange={(m) => { setMode(m); setResults(null); setStatus({ state: 'idle', error: '' }); }} icons={modeIcon} stretch /></div>

        <Hud corners>
          <datalist id="airports">{AIRPORTS.map((a) => <option key={a} value={a} />)}</datalist>
          <div className="grid auto-stack" style={{ gridTemplateColumns: mode === 'Flights' ? 'minmax(0,1.3fr) auto minmax(0,1.3fr) minmax(0,1fr) auto' : 'minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) auto', gap: 10, alignItems: 'end' }}>
            {mode === 'Flights' ? (
              <>
                <div className="field"><label htmlFor="tv-from">From</label><div className="input"><Plane size={18} /><input id="tv-from" list="airports" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="City or code, e.g. PNQ" /></div></div>
                <button className="icon-btn" style={{ marginBottom: 4 }} onClick={swap} aria-label="Swap origin and destination"><ArrowLeftRight size={17} /></button>
                <div className="field"><label htmlFor="tv-to">To</label><div className="input"><Plane size={18} style={{ transform: 'rotate(45deg)' }} /><input id="tv-to" list="airports" value={to} onChange={(e) => setTo(e.target.value)} placeholder="City or code, e.g. GOI" /></div></div>
                <div className="field"><label htmlFor="tv-dep">Departure</label><div className="input"><input id="tv-dep" type="date" value={dep} min={isoIn(0)} onChange={(e) => setDep(e.target.value)} /></div></div>
              </>
            ) : (
              <>
                <div className="field"><label htmlFor="tv-to">Destination</label><div className="input"><MapPinned size={18} /><input id="tv-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="City or area, e.g. Goa" /></div></div>
                <div className="field"><label htmlFor="tv-dep">Check-in</label><div className="input"><input id="tv-dep" type="date" value={dep} min={isoIn(0)} onChange={(e) => setDep(e.target.value)} /></div></div>
                <div className="field"><label htmlFor="tv-ret">Check-out</label><div className="input"><input id="tv-ret" type="date" value={ret} min={dep} onChange={(e) => setRet(e.target.value)} /></div></div>
              </>
            )}
            <div style={{ position: 'relative' }}>
              <button className="input" style={{ width: '100%', minWidth: 150 }} onClick={() => setPaxOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={paxOpen}>
                <Users size={20} /><span style={{ textAlign: 'left', flex: 1, color: '#fff' }}>{pax} {mode === 'Flights' ? 'Traveler' : 'Guest'}{pax > 1 ? 's' : ''}</span><ChevronRight size={16} />
              </button>
              {paxOpen && (
                <div className="menu" style={{ right: 0, padding: 12, minWidth: 200 }} role="dialog" aria-label="Travelers">
                  <div className="row between"><span>{mode === 'Flights' ? 'Travelers' : 'Guests'}</span><span className="row"><button className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => setPax((n) => Math.max(1, n - 1))} aria-label="Fewer">−</button><b>{pax}</b><button className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => setPax((n) => Math.min(9, n + 1))} aria-label="More">+</button></span></div>
                  <NeonButton size="sm" block style={{ marginTop: 10 }} onClick={() => setPaxOpen(false)}>Done</NeonButton>
                </div>
              )}
            </div>
          </div>
          <div className="row between wrap" style={{ marginTop: 14 }}>
            <span className="t-mute">{mode === 'Flights' ? 'One-way fares in ₹, cheapest first. Use airport codes such as PNQ, BOM, DEL, GOI.' : `Prices in ₹ for ${nights} night${nights > 1 ? 's' : ''}, cheapest first.`}</span>
            <NeonButton variant="ai" size="lg" onClick={() => void search()} disabled={status.state === 'loading'}>{status.state === 'loading' ? <span className="spinner" /> : <Search size={18} />} Search {mode}</NeonButton>
          </div>
          {status.state === 'error' && <div className="tag red" role="alert" style={{ padding: 10, marginTop: 12, whiteSpace: 'normal' }}>{/bearer|401/i.test(status.error) ? 'Sign in to search live fares.' : status.error}</div>}
          {sorted && (
            <div className="fade-in" style={{ marginTop: 14 }}>
              <div className="row between" style={{ marginBottom: 6 }}>
                <b>{sorted.length} {mode.toLowerCase()} · {searchedFor}</b>
                <button className="chip" onClick={() => setSortBy((s) => (s === 'price' ? 'name' : 'price'))}><ArrowUpDown size={14} /> Sort: {sortBy === 'price' ? 'Lowest price' : 'Name'}</button>
              </div>
              <div className="list">
                {sorted.map((r, i) => {
                  const Icon = modeIcon[mode];
                  return (
                    <div className="li" key={r.id}>
                      <IconBox icon={Icon} tone={i === 0 && sortBy === 'price' ? 'green' : 'blue'} size="sm" />
                      <div className="grow"><div className="t-title">{r.title} {i === 0 && sortBy === 'price' && <span className="tag green">Lowest</span>}</div><div className="t-sub mono">{[r.sub, r.meta].filter(Boolean).join(' · ')}</div></div>
                      <div style={{ textAlign: 'right' }}><b style={{ fontSize: 16 }}>{money(r.price, r.currency)}</b><div className="t-mute" style={{ fontSize: 11 }}>{r.per}</div></div>
                      <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => { recordFeedback(r, true); toast('Noted — more like this.'); }} aria-label={`Interested in ${r.title}`} title="Interested"><ThumbsUp size={14} /></button>
                      <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => { recordFeedback(r, false); toast('Noted — fewer like this.'); }} aria-label={`Not interested in ${r.title}`} title="Not interested"><ThumbsDown size={14} /></button>
                      <NeonButton size="sm" variant="primary" onClick={() => setBook({ title: r.title, link: r.link, lines: [`${mode}: ${r.title}`, r.sub, mode === 'Flights' ? `${searchedFor} · ${dep}` : `${searchedFor} · ${dep} → ${ret}`, `${money(r.price, r.currency)} ${r.per}`] })}>Book</NeonButton>
                    </div>
                  );
                })}
              </div>
              {!sorted.length && <div className="empty">No {mode.toLowerCase()} found for those details. Try different dates or places.</div>}
            </div>
          )}
        </Hud>
        <SyncStatus stores={[bookingsStore, tripsStore, travelFeedbackStore]} />
      </div>

      <div className="rail">
        <AICommandPanel title="AI Trip Planner" description="Tell me where you want to go and I'll create a personalized itinerary with stays, activities and more."
          prompts={['Plan a 3 day trip to Goa under ₹20,000', 'Suggest a weekend trip near Pune', 'What should I pack for Manali in December?']} promptStyle="boxes"
          onAsk={ai} cta="Plan My Trip with AI" ctaIcon={Sparkles} placeholder="Where do you want to go?" />

        <Hud corners title="Latest saved booking" action="View All" onAction={() => setDrawer('bookings')}>
          {latest ? (
            <button className="row" style={{ background: 'none', border: 0, width: '100%', textAlign: 'left', gap: 12 }} onClick={() => setDrawer('bookings')}>
              <IconBox icon={Plane} tone="cyan" size="lg" />
              <div style={{ flex: 1 }}><b style={{ fontSize: 16 }}>{latest.title}</b><div className="t-sub">{latest.detail}</div><span className={`tag ${latest.status === 'Confirmed' ? 'green' : 'amber'}`}>{latest.status}</span></div>
              <ChevronRight size={18} />
            </button>
          ) : <div className="empty">Nothing saved yet. Search and press Book to save a plan.</div>}
        </Hud>
        {([['bookings', ClipboardList, 'My Bookings', 'Trips you saved or approved', 'blue'], ['itinerary', Map, 'Travel Itinerary', 'Plans saved from the AI planner', 'cyan']] as const).map(([k, I, t, s, tone]) => (
          <button key={k} className="hud row" style={{ textAlign: 'left', gap: 14 }} onClick={() => setDrawer(k)}>
            <IconBox icon={I} tone={tone as Tone} size="lg" />
            <div style={{ flex: 1 }}><div className="t-title" style={{ fontSize: 15 }}>{t}</div><div className="t-sub">{s}</div></div>
            <ChevronRight size={18} />
          </button>
        ))}
      </div>

      <Drawer title="My Bookings" icon={ClipboardList} open={drawer === 'bookings'} onClose={() => setDrawer(null)}>
        {bookings.map((b) => (
          <div key={b.id} className="tile row"><BadgeCheck size={20} className={b.status === 'Confirmed' ? 'c-green' : 'c-amber'} /><div style={{ flex: 1 }}><b>{b.title}</b><div className="t-sub">{b.detail}</div>{b.link && <a className="c-blue row" style={{ gap: 4, fontSize: 12 }} href={b.link} target="_blank" rel="noopener noreferrer">Open <ExternalLink size={11} /></a>}</div><span className={`tag ${b.status === 'Confirmed' ? 'green' : 'amber'}`}>{b.status}</span></div>
        ))}
        {!bookings.length && <div className="empty">No bookings saved yet.</div>}
      </Drawer>
      <Drawer title="Travel Itineraries" icon={Map} open={drawer === 'itinerary'} onClose={() => setDrawer(null)}>
        {trips.map((t) => t.days.map((d) => (
          <div key={t.id + d.day} className="tile"><b className="row"><CalendarDays size={15} className="c-cyan" /> {t.destination}</b><ul style={{ margin: '6px 0 0', paddingLeft: 20 }} className="t-sub">{d.items.map((i) => <li key={i}>{i}</li>)}</ul></div>
        )))}
        {!trips.length && <div className="empty">No itineraries yet. Ask the AI Trip Planner and save its plan.</div>}
      </Drawer>

      {book && (
        <FuturisticModal title="Approval required" icon={ShieldCheck} tone="amber" onClose={() => setBook(null)}>
          <p style={{ marginBottom: 10 }}>You are saving: <b>{book.title}</b></p>
          <ul className="t-sub" style={{ margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.8 }}>{book.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="t-mute" style={{ marginBottom: 16 }}>AURA does not book or charge anything. Approving records your choice and saves it to My Bookings; complete the purchase with the provider.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <NeonButton variant="danger" onClick={() => setBook(null)}>Cancel</NeonButton>
            {book.link && <a className="btn" href={book.link} target="_blank" rel="noopener noreferrer">Open provider <ExternalLink size={13} /></a>}
            <NeonButton variant="primary" onClick={() => {
              const b = book;
              setBook(null);
              bookingsStore.set((bs) => [...bs, { id: uid('bk'), title: b.title, detail: b.lines.slice(1, 3).join(' · '), status: 'Saved', link: b.link }]);
              void aura.approve(`Save booking: ${b.title}`, { lines: b.lines, link: b.link }).then((r) => toast(r.message)).catch(() => toast('Saved locally, but the approval could not be recorded.'));
            }}>Approve &amp; save</NeonButton>
          </div>
        </FuturisticModal>
      )}
    </div>
  );
}
