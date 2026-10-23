// Traduzioni della UI: catena di lingue, t(key, params) con plurali CLDR, markup
// statico (data-i18n…), formattazione con Intl. Le lingue arrivano dai cataloghi
// (/api/core/i18n/languages): nessun elenco di lingue nel codice.
window.I18n = (() => {
  const STORAGE_KEY = 'devdock.lang';
  let source = 'it';
  let languages = [];          // [{ tag, name, nativeName, dir, completeness, core }]
  let lang = source;           // lingua attiva
  let chain = [source];        // lingua attiva → lingue base → sorgente
  let extTags = new Map();     // code → tag con un catalogo dell'estensione
  const catalogs = new Map();  // tag → Map(chiave completa → valore)
  const loaded = new Set();    // "<scope>:<tag>" già scaricati
  const warned = new Set();
  const listeners = new Set();

  const storage = {
    get() { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(STORAGE_KEY, v); } catch { /* storage non disponibile */ } },
  };

  // pt-BR → ['pt-BR', 'pt']
  const truncations = tag => {
    const parts = String(tag).split('-');
    return parts.map((_, i) => parts.slice(0, parts.length - i).join('-'));
  };
  const unique = list => [...new Set(list)];
  const chainFor = tag => unique([...truncations(tag), source]);

  // Primo tag desiderato disponibile, anche troncando la variante regionale
  function negotiate(wanted, tags) {
    const byLower = new Map(tags.map(t => [t.toLowerCase(), t]));
    for (const w of wanted.filter(Boolean)) {
      for (const t of truncations(w)) {
        const hit = byLower.get(t.toLowerCase());
        if (hit) return hit;
      }
    }
    return null;
  }

  async function fetchCatalog(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  function merge(tag, entries, prefix) {
    if (!catalogs.has(tag)) catalogs.set(tag, new Map());
    const map = catalogs.get(tag);
    for (const [k, v] of Object.entries(entries)) if (k !== '_meta') map.set(prefix + k, v);
  }

  // Scarica i cataloghi della catena che mancano (core ed estensioni)
  async function loadChain() {
    const coreTags = new Set(languages.filter(l => l.core).map(l => l.tag));
    const jobs = [];
    for (const tag of chain) {
      if (coreTags.has(tag) && !loaded.has(`core:${tag}`)) {
        loaded.add(`core:${tag}`);
        jobs.push(fetchCatalog(`/core/i18n/${tag}.json`).then(c => merge(tag, c, '')));
      }
      for (const [code, tags] of extTags) {
        if (!tags.includes(tag) || loaded.has(`${code}:${tag}`)) continue;
        loaded.add(`${code}:${tag}`);
        jobs.push(fetchCatalog(`/ext/${code}/i18n/${tag}.json`).then(c => merge(tag, c, `${code}.`)));
      }
    }
    const results = await Promise.allSettled(jobs);
    results.filter(r => r.status === 'rejected').forEach(r => console.warn('[i18n]', r.reason?.message));
  }

  function applyDocumentLang() {
    const info = languages.find(l => l.tag === lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = info?.dir || 'ltr';
  }

  // exts: [{ code, i18n: [tag…] }] dalle estensioni attive
  async function init(exts = []) {
    extTags = new Map(exts.filter(e => e.i18n?.length).map(e => [e.code, e.i18n]));
    try {
      const data = await fetchCatalog('/api/core/i18n/languages');
      source = data.source || source;
      languages = data.languages || [];
    } catch (e) { console.warn('[i18n] lingue non disponibili:', e.message); }
    const wanted = [storage.get(), ...(navigator.languages || [navigator.language])];
    lang = negotiate(wanted, languages.map(l => l.tag)) || source;
    chain = chainFor(lang);
    await loadChain();
    applyDocumentLang();
  }

  // Estensioni cambiate a runtime (installate, ricaricate, tolte): i loro cataloghi si
  // scaricano di nuovo; changed: codici da rileggere anche se già caricati
  async function setExtensions(exts = [], changed = []) {
    extTags = new Map(exts.filter(e => e.i18n?.length).map(e => [e.code, e.i18n]));
    for (const code of changed) {
      for (const key of [...loaded]) if (key.startsWith(`${code}:`)) loaded.delete(key);
      for (const map of catalogs.values()) for (const k of [...map.keys()]) if (k.startsWith(`${code}.`)) map.delete(k);
    }
    await loadChain();
  }

  // Cambio di lingua scelto dall'utente: salvato, cataloghi caricati, UI avvisata
  async function setLanguage(tag) {
    const hit = negotiate([tag], languages.map(l => l.tag));
    if (!hit) return;
    storage.set(hit);
    if (hit === lang) return;
    lang = hit;
    chain = chainFor(lang);
    clearFormatters();
    await loadChain();
    applyDocumentLang();
    apply(document);
    for (const fn of listeners) { try { fn(lang); } catch (e) { console.error(e); } }
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // ---- traduzione ----
  const pluralRules = new Map();
  const plural = tag => {
    if (!pluralRules.has(tag)) pluralRules.set(tag, new Intl.PluralRules(tag));
    return pluralRules.get(tag);
  };

  function lookup(key) {
    for (const tag of chain) {
      const v = catalogs.get(tag)?.get(key);
      if (v !== undefined) return { value: v, tag };
    }
    return null;
  }

  function has(key) { return !!lookup(key); }

  // t('core.toast.saved'), t('git.commits', { count: 3 }): {nome} sostituiti con params,
  // plurali scelti con Intl.PluralRules su params.count (formattato con fmt.number).
  // Chiave mancante → la chiave stessa.
  function t(key, params = {}) {
    const hit = lookup(key);
    if (!hit) {
      if (!warned.has(key)) { warned.add(key); console.warn(`[i18n] chiave mancante: ${key}`); }
      return key;
    }
    let text = hit.value;
    if (typeof text === 'object') {
      const n = Number(params.count);
      const cat = Number.isFinite(n) ? plural(hit.tag).select(n) : 'other';
      text = text[cat] ?? text.other;
    }
    return text.replace(/\{(\w+)\}/g, (m, name) => {
      if (!(name in params)) return m;
      const v = params[name];
      // solo {count} è una quantità da formattare (porte, pid e id restano come sono)
      return name === 'count' && typeof v === 'number' ? fmt.number(v) : String(v ?? '');
    });
  }

  // Testo di un errore delle API ({ error, code, params } o una stringa): il codice
  // "<ns>.<nome>" si traduce con la chiave "<ns>.errors.<nome>", altrimenti resta error
  function errorText(data, fallback = '') {
    if (data == null) return fallback;
    if (typeof data === 'string') return data;
    if (data.code) {
      const key = String(data.code).replace(/^([^.]+)\./, '$1.errors.');
      if (has(key)) return t(key, data.params || {});
    }
    return data.error || data.message || fallback;
  }

  // Chiave relativa al namespace di un'estensione; "core." resta globale
  const qualify = (key, ns) => (!ns || key.startsWith('core.') ? key : `${ns}.${key}`);

  // Traduttore legato al namespace di un'estensione (ctx.t)
  const scoped = ns => (key, params) => t(qualify(key, ns), params);

  // Testo di un campo del manifest: stringa oppure { "<tag>": "…" }
  function pick(value) {
    if (value == null || typeof value !== 'object') return value ?? '';
    for (const tag of chain) if (value[tag]) return value[tag];
    return value[source] ?? Object.values(value)[0] ?? '';
  }

  // ---- markup statico: data-i18n (testo), data-i18n-title/-placeholder/-aria-label ----
  const ATTRS = [['i18nTitle', 'title'], ['i18nPlaceholder', 'placeholder'], ['i18nAriaLabel', 'aria-label']];
  const SELECTOR = '[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]';

  // ns: codice dell'estensione proprietaria del markup (default: data-i18n-ns del contenitore più vicino)
  function apply(root, ns) {
    if (!root) return;
    const nodes = root.matches?.(SELECTOR) ? [root, ...root.querySelectorAll(SELECTOR)] : root.querySelectorAll(SELECTOR);
    for (const el of nodes) {
      const space = ns ?? el.closest('[data-i18n-ns]')?.dataset.i18nNs;
      if (el.dataset.i18n) el.textContent = t(qualify(el.dataset.i18n, space));
      for (const [prop, attr] of ATTRS) {
        if (el.dataset[prop]) el.setAttribute(attr, t(qualify(el.dataset[prop], space)));
      }
    }
  }

  // ---- formattazione con Intl nella lingua attiva ----
  const formatters = new Map();
  function clearFormatters() { formatters.clear(); }
  function cached(kind, opts, make) {
    const id = kind + JSON.stringify(opts || {});
    if (!formatters.has(id)) formatters.set(id, make());
    return formatters.get(id);
  }

  const fmt = {
    number: (n, opts) => cached('n', opts, () => new Intl.NumberFormat(lang, opts)).format(n),
    // data e ora; opts come Intl.DateTimeFormat (default: data media + ora breve)
    date: (d, opts = { dateStyle: 'medium', timeStyle: 'short' }) => {
      const date = d instanceof Date ? d : new Date(d);
      return isNaN(date) ? '' : cached('d', opts, () => new Intl.DateTimeFormat(lang, opts)).format(date);
    },
    // "3 minuti fa", "tra 2 ore": l'unità più grande che rientra
    relative(d, now = Date.now()) {
      const date = d instanceof Date ? d : new Date(d);
      if (isNaN(date)) return '';
      const secs = Math.round((date - now) / 1000);
      const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
      const [unit, size] = units.find(([, s]) => Math.abs(secs) >= s) || ['second', 1];
      return cached('r', null, () => new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })).format(Math.trunc(secs / size), unit);
    },
    list: (items, type = 'conjunction') => cached('l', { type }, () => new Intl.ListFormat(lang, { type })).format(items.map(String)),
    // Dimensione in byte con l'unità adatta (kB, MB…)
    bytes(n) {
      const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
      let i = 0, v = Number(n) || 0;
      while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i++; }
      return fmt.number(v, { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: i ? 1 : 0 });
    },
    // Durata in secondi: "2 h 10 min" (Intl.DurationFormat dove c'è, altrimenti unità singole)
    duration(secs) {
      secs = Math.max(0, Math.floor(secs));
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
      const parts = h ? { hours: h, minutes: m } : m ? { minutes: m, seconds: s } : { seconds: s };
      if (typeof Intl.DurationFormat === 'function') {
        return cached('du', null, () => new Intl.DurationFormat(lang, { style: 'narrow' })).format(parts);
      }
      const unit = { hours: 'hour', minutes: 'minute', seconds: 'second' };
      return Object.entries(parts)
        .map(([k, v]) => fmt.number(v, { style: 'unit', unit: unit[k], unitDisplay: 'narrow' }))
        .join(' ');
    },
  };

  return {
    init, setExtensions, setLanguage, onChange, t, has, errorText, scoped, qualify, pick, apply, fmt,
    get lang() { return lang; },
    get source() { return source; },
    get languages() { return languages.slice(); },
  };
})();
