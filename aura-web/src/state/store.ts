import { useEffect, useSyncExternalStore } from 'react';
import { apiGet, apiSend } from '../services/api';

/** Minimal shared store (no dependency). Screens showing the same data read/write one store. */
export function createStore<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  const get = () => state;
  const set = (update: T | ((prev: T) => T)) => {
    state = typeof update === 'function' ? (update as (prev: T) => T)(state) : update;
    subs.forEach((f) => f());
  };
  const subscribe = (f: () => void) => {
    subs.add(f);
    return () => { subs.delete(f); };
  };
  const use = () => useSyncExternalStore(subscribe, get, get);
  return { get, set, use };
}

let seq = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** Every record store registers here so they can all be reset on sign-out. */
export const recordStores: { reset: () => void }[] = [];

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * A list store persisted through the backend `/records/:collection` API.
 * Starts empty, loads on first `use()`, and every `set()` is diffed by `id`
 * and written through (PUT for new/changed rows, DELETE for removed ones).
 */
export function createRecordStore<T extends { id: string }>(collection: string) {
  const base = createStore<T[]>([]);
  const meta = createStore<{ status: LoadStatus; error: string }>({ status: 'idle', error: '' });
  let loaded = false;

  const load = async () => {
    meta.set({ status: 'loading', error: '' });
    try {
      const res = await apiGet<{ data: T[] }>(`/records/${collection}`);
      base.set(res.data);
      meta.set({ status: 'ready', error: '' });
    } catch (e) {
      meta.set({ status: 'error', error: e instanceof Error ? e.message : 'Failed to load' });
    }
  };

  const set = (update: T[] | ((prev: T[]) => T[])) => {
    const prev = base.get();
    base.set(update);
    const next = base.get();
    const prevById = new Map(prev.map((r) => [r.id, r]));
    const nextIds = new Set(next.map((r) => r.id));
    const fail = (e: unknown) => meta.set({ status: 'error', error: e instanceof Error ? e.message : 'Save failed' });
    for (const r of next) {
      const old = prevById.get(r.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(r)) {
        apiSend('PUT', `/records/${collection}/${encodeURIComponent(r.id)}`, r).catch(fail);
      }
    }
    for (const r of prev) {
      if (!nextIds.has(r.id)) apiSend('DELETE', `/records/${collection}/${encodeURIComponent(r.id)}`).catch(fail);
    }
  };

  const use = () => {
    useEffect(() => {
      if (!loaded) { loaded = true; void load(); }
    }, []);
    return base.use();
  };
  const useMeta = meta.use;
  const reload = () => { loaded = true; return load(); };
  const reset = () => { loaded = false; base.set([]); meta.set({ status: 'idle', error: '' }); };

  const api = { get: base.get, set, use, useMeta, reload, reset };
  recordStores.push(api);
  return api;
}
