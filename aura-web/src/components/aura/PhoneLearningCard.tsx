import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Eye, ShieldCheck, SkipForward, Trash2 } from 'lucide-react';
import { Hud, NeonButton, toast } from '../aura';
import { Toggle } from '../ui';
import { AuraScreen, type LearnedSummary } from '../../native/screen';
import { openAccessibilitySettings } from '../../services/extension';

const isNative = Capacitor.isNativePlatform();
type Status = { accessibility: boolean; screenshot: boolean; learning: boolean; autoSkipAds: boolean; androidSdk: number };

const VERBS: Record<string, string> = {
  like: 'likes', comment: 'comments', share: 'shares', save: 'saves', follow: 'follows', subscribe: 'subscribes', reply: 'replies',
  send: 'messages sent', call: 'calls', video_call: 'video calls', search: 'searches', add_to_cart: 'cart adds', watch_later: 'watch-laters',
};
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;

/**
 * What the phone's AURA does on its own, and what it has learned: the YouTube ad skipper, "find this" (visual search),
 * and the habit learner. Learning is opt-in and shows exactly what is kept: counts of apps, kinds of tap, people
 * chatted with and topics liked. Never what is typed or messaged. Everything stays on the phone.
 */
export default function PhoneLearningCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [learned, setLearned] = useState<LearnedSummary | null>(null);

  const load = useCallback(async () => {
    if (!isNative) return;
    try {
      const s = await AuraScreen.status();
      setStatus(s);
      setLearned(await AuraScreen.learned());   // kept even when learning is off, so it can still be seen and wiped
    } catch { /* an older build without the plugin */ }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 20_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!isNative) {
    return (
      <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>On your phone</span>}>
        <div className="t-sub">Seeing your screen, finding products you look at, skipping YouTube ads and learning your habits work in the AURA Android app.</div>
      </Hud>
    );
  }

  const setLearning = async (on: boolean) => {
    await AuraScreen.setLearning({ enabled: on }).catch(() => undefined);
    toast(on ? 'AURA will learn from how you use your phone. You can stop and wipe it any time.' : 'Learning is off. What was learned is kept until you wipe it.');
    void load();
  };
  const forget = async () => {
    if (!window.confirm('Wipe everything AURA has learned from your phone use?')) return;
    await AuraScreen.forgetLearned().catch(() => undefined);
    toast('Wiped. AURA starts fresh.');
    void load();
  };

  return (
    <Hud corners title={<span className="section-title" style={{ fontSize: 20 }}>On your phone</span>}>
      <div className="stack" style={{ gap: 12 }}>
        {status && !status.accessibility && (
          <div className="tile stack" style={{ gap: 8 }}>
            <div className="t-sub">AURA needs its accessibility access to see your screen, tap for you and skip ads. It is off.</div>
            <NeonButton variant="primary" onClick={() => openAccessibilitySettings()}>Turn on accessibility access</NeonButton>
          </div>
        )}

        <div className="row between">
          <div className="row" style={{ gap: 8 }}><SkipForward size={16} className="c-cyan" /><div><b>Skip YouTube ads</b><div className="t-sub">Presses “Skip ad” as soon as it appears</div></div></div>
          <Toggle on={status?.autoSkipAds ?? true} label="Skip YouTube ads" onChange={(v) => { void AuraScreen.setAutoSkipAds({ enabled: v }).then(load); }} />
        </div>

        <div className="row" style={{ gap: 8 }}>
          <Eye size={16} className="c-cyan" />
          <div>
            <b>See my screen</b>
            <div className="t-sub">
              Say “Hey Aura, what’s on my screen”, “find this” while looking at a product, or “tap the second video”.
              {status && !status.screenshot && status.accessibility ? ' Finding products needs Android 11+.' : ''}
              {' '}The screen (or a screenshot) is sent to AURA’s server only when you ask. Banking, payment and password apps are never read.
            </div>
          </div>
        </div>

        <div className="row between">
          <div className="row" style={{ gap: 8 }}><ShieldCheck size={16} className="c-cyan" /><div><b>Learn how I use my phone</b>
            <div className="t-sub">Counts only: which apps and when, taps like Like / Share / Send, who you chat with on WhatsApp, topics you like. Never what you type or message. Stays on this phone.</div></div></div>
          <Toggle on={!!status?.learning} label="Learn how I use my phone" onChange={(v) => void setLearning(v)} />
        </div>

        {status?.learning && learned && (
          <div className="stack" style={{ gap: 10 }}>
            {learned.apps.length > 0 && (
              <div><div className="t-sub">Most used</div>
                <div className="list">{learned.apps.map((a) => (
                  <div className="li" key={a.pkg}><div className="grow">{a.label}</div><span className="mono">{a.minutes} min · around {hourLabel(a.peakHour)}</span></div>
                ))}</div></div>
            )}
            {learned.contacts.length > 0 && (
              <div><div className="t-sub">Chat most (names stay on this phone)</div>
                <div className="list">{learned.contacts.map((c) => (
                  <div className="li" key={c.name}><div className="grow">{c.name}</div><span className="mono">{c.opens} chats{c.messages ? ` · ${c.messages} sent` : ''}{c.calls ? ` · ${c.calls} calls` : ''}</span></div>
                ))}</div></div>
            )}
            {learned.actions.length > 0 && (
              <div><div className="t-sub">What you do</div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{learned.actions.map((a) => (
                  <span className="tag blue" key={`${a.pkg}|${a.verb}`}>{a.label}: {a.count} {VERBS[a.verb] ?? a.verb}</span>
                ))}</div></div>
            )}
            {learned.interests.length > 0 && (
              <div><div className="t-sub">Topics you like</div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{learned.interests.map((t) => <span className="tag" key={t}>{t}</span>)}</div></div>
            )}
            {!learned.apps.length && !learned.contacts.length && !learned.interests.length && <div className="t-sub">Nothing yet. Use your phone as usual and check back later.</div>}
          </div>
        )}

        {(status?.learning || (learned && (learned.apps.length || learned.contacts.length || learned.interests.length))) && (
          <NeonButton icon={Trash2} onClick={() => void forget()}>Wipe what AURA learned</NeonButton>
        )}
      </div>
    </Hud>
  );
}
