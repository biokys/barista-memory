// Tiny i18n: dictionaries are flat JSON keyed by dotted paths, with {name}
// placeholders. The language is remembered per browser; the default follows
// the browser's own preference with Czech as the fallback.

let dict = {};
let lang = "cs";

export async function initI18n() {
  const saved = localStorage.getItem("lang");
  lang = saved || (navigator.language?.startsWith("en") ? "en" : "cs");
  await load();
}

async function load() {
  const res = await fetch(`/i18n/${lang}.json`, { cache: "no-cache" });
  dict = await res.json();
}

export function currentLang() { return lang; }

export function setLang(next) {
  lang = next;
  localStorage.setItem("lang", next);
  // Synchronous switch for the caller; the dictionary is small.
  const xhr = new XMLHttpRequest();
  xhr.open("GET", `/i18n/${lang}.json`, false);
  xhr.send();
  dict = JSON.parse(xhr.responseText);
}

export function t(key, vars = {}) {
  let s = dict[key];
  if (s === undefined) return key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Locale for Intl formatting, from the UI language. */
export function locale() { return lang === "cs" ? "cs-CZ" : "en-GB"; }
