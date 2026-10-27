// Veröffentlicht fällige Posts aus warteschlange/*.json auf Instagram, Facebook und Threads.
// Läuft per GitHub Action alle 15 Minuten. Keine Abhängigkeiten, nur Node 20 (fetch).
//
// Umgebung:
//   META_TOKEN       Systemnutzer-Token (Instagram + Seite), läuft nicht ab
//   FB_PAGE_TOKEN    Seiten-Token der Facebook-Seite
//   IG_USER_ID       Instagram-Business-Konto-ID
//   FB_PAGE_ID       Facebook-Seiten-ID
//   THREADS_TOKEN    Threads-Nutzer-Token (60 Tage, wird wöchentlich erneuert)
//   MEDIA_BASE       öffentliche Basis-URL der Medien (GitHub Pages), mit / am Ende
//   TROCKEN=1        nur prüfen und Container anlegen, nichts veröffentlichen
//   NUR=<post-id>    nur diesen Post (zum Testen), ignoriert die Uhrzeit

import fs from "node:fs";
import path from "node:path";

const GRAPH = "https://graph.facebook.com/v24.0";
const THREADS = "https://graph.threads.net/v1.0";
const ORDNER = "warteschlange";
const SPAETESTENS_STUNDEN = 6; // danach gilt ein Post als verpasst
const MAX_PRO_LAUF = 10;
const MAX_VERSUCHE = 3;

const env = process.env;
const TROCKEN = env.TROCKEN === "1";
const NUR = env.NUR || "";
const BASE = (env.MEDIA_BASE || "").replace(/\/?$/, "/");

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (p) => BASE + p.replace(/^\/+/, "");

async function api(basis, pfad, { methode = "GET", token, felder = {} } = {}) {
  const params = new URLSearchParams({ ...felder, access_token: token });
  const ziel = `${basis}${pfad}`;
  const res =
    methode === "GET"
      ? await fetch(`${ziel}?${params}`)
      : await fetch(ziel, { method: methode, body: params });
  const daten = await res.json().catch(() => ({}));
  if (!res.ok || daten.error) {
    const f = daten.error || {};
    throw new Error(`${methode} ${pfad}: ${f.message || res.status}${f.error_user_msg ? ` (${f.error_user_msg})` : ""}`);
  }
  return daten;
}

async function erreichbar(pfade) {
  for (const p of pfade) {
    const res = await fetch(url(p), { method: "HEAD" });
    if (!res.ok) return `${p} noch nicht online (${res.status})`;
  }
  return null;
}

// Wartet, bis ein Video-Container verarbeitet ist (Instagram: status_code, Threads: status).
async function bereit(basis, id, token, feld) {
  for (let i = 0; i < 48; i++) {
    const d = await api(basis, `/${id}`, { token, felder: { fields: feld } });
    const s = d[feld];
    if (s === "FINISHED" || s === "PUBLISHED") return;
    if (s === "ERROR" || s === "EXPIRED") throw new Error(`Container ${id}: ${s}`);
    await warte(10_000);
  }
  throw new Error(`Container ${id} nach 8 Minuten nicht fertig`);
}

const istVideo = (p) => /\.(mp4|mov)$/i.test(p);

// ---------- Instagram ----------
async function instagram(post) {
  const t = env.META_TOKEN, ig = env.IG_USER_ID;
  const m = post.medien || [];
  const caption = post.text || "";
  const kind = (p, extra = {}) =>
    istVideo(p) ? { media_type: "VIDEO", video_url: url(p), ...extra } : { image_url: url(p), ...extra };

  let felder;
  if (post.format === "karussell") {
    const kinder = [];
    for (const [i, p] of m.entries()) {
      const k = await api(GRAPH, `/${ig}/media`, {
        methode: "POST", token: t,
        felder: { ...kind(p, { is_carousel_item: "true" }), ...(post.alt?.[i] && !istVideo(p) ? { alt_text: post.alt[i] } : {}) },
      });
      if (istVideo(p)) await bereit(GRAPH, k.id, t, "status_code");
      kinder.push(k.id);
    }
    felder = { media_type: "CAROUSEL", children: kinder.join(","), caption };
  } else if (post.format === "reel") {
    felder = { media_type: "REELS", video_url: url(m[0]), caption, share_to_feed: "true" };
  } else if (post.format === "story") {
    felder = istVideo(m[0]) ? { media_type: "STORIES", video_url: url(m[0]) } : { media_type: "STORIES", image_url: url(m[0]) };
  } else if (post.format === "bild") {
    felder = { image_url: url(m[0]), caption, ...(post.alt?.[0] ? { alt_text: post.alt[0] } : {}) };
  } else {
    throw new Error(`Instagram kennt das Format „${post.format}“ nicht`);
  }

  const c = await api(GRAPH, `/${ig}/media`, { methode: "POST", token: t, felder });
  if (post.format === "reel" || istVideo(m[0] || "")) await bereit(GRAPH, c.id, t, "status_code");
  if (TROCKEN) return { id: `trocken:${c.id}` };
  const p = await api(GRAPH, `/${ig}/media_publish`, { methode: "POST", token: t, felder: { creation_id: c.id } });
  const info = await api(GRAPH, `/${p.id}`, { token: t, felder: { fields: "permalink" } }).catch(() => ({}));
  return { id: p.id, link: info.permalink };
}

// ---------- Facebook-Seite ----------
async function facebook(post) {
  const t = env.FB_PAGE_TOKEN, page = env.FB_PAGE_ID;
  const m = post.medien || [];
  const text = post.text || "";
  if (TROCKEN) {
    // Unveröffentlichtes Foto anlegen und gleich wieder löschen: prüft Recht und Medien-URL.
    const bild = m.find((p) => !istVideo(p));
    if (!bild) return { id: "trocken" };
    const r = await api(GRAPH, `/${page}/photos`, { methode: "POST", token: t, felder: { url: url(bild), published: "false" } });
    await api(GRAPH, `/${r.id}`, { methode: "DELETE", token: t });
    return { id: `trocken:${r.id}` };
  }

  if (post.format === "text" || m.length === 0) {
    const r = await api(GRAPH, `/${page}/feed`, { methode: "POST", token: t, felder: { message: text } });
    return { id: r.id };
  }
  if (istVideo(m[0])) {
    const r = await api(GRAPH, `/${page}/videos`, { methode: "POST", token: t, felder: { file_url: url(m[0]), description: text } });
    return { id: r.id };
  }
  if (m.length === 1) {
    const r = await api(GRAPH, `/${page}/photos`, { methode: "POST", token: t, felder: { url: url(m[0]), message: text } });
    return { id: r.post_id || r.id };
  }
  const ids = [];
  for (const p of m) {
    const r = await api(GRAPH, `/${page}/photos`, { methode: "POST", token: t, felder: { url: url(p), published: "false" } });
    ids.push(r.id);
  }
  const felder = { message: text };
  ids.forEach((id, i) => (felder[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
  const r = await api(GRAPH, `/${page}/feed`, { methode: "POST", token: t, felder });
  return { id: r.id };
}

// ---------- Threads ----------
async function threads(post) {
  const t = env.THREADS_TOKEN;
  const m = post.medien || [];
  const text = post.text || "";
  const kind = (p, extra = {}) =>
    istVideo(p) ? { media_type: "VIDEO", video_url: url(p), ...extra } : { media_type: "IMAGE", image_url: url(p), ...extra };

  let felder;
  if (m.length === 0) felder = { media_type: "TEXT", text };
  else if (m.length === 1) felder = { ...kind(m[0]), text };
  else {
    const kinder = [];
    for (const p of m) {
      const k = await api(THREADS, "/me/threads", { methode: "POST", token: t, felder: kind(p, { is_carousel_item: "true" }) });
      if (istVideo(p)) await bereit(THREADS, k.id, t, "status");
      kinder.push(k.id);
    }
    felder = { media_type: "CAROUSEL", children: kinder.join(","), text };
  }
  const c = await api(THREADS, "/me/threads", { methode: "POST", token: t, felder });
  if (m.some(istVideo)) await bereit(THREADS, c.id, t, "status");
  if (TROCKEN) return { id: `trocken:${c.id}` };
  await warte(m.length ? 30_000 : 0); // Meta empfiehlt eine kurze Pause vor dem Veröffentlichen
  const p = await api(THREADS, "/me/threads_publish", { methode: "POST", token: t, felder: { creation_id: c.id } });
  const info = await api(THREADS, `/${p.id}`, { token: t, felder: { fields: "permalink" } }).catch(() => ({}));
  return { id: p.id, link: info.permalink };
}

const KANAELE = { instagram, facebook, threads };

// ---------- Ablauf ----------
const jetzt = Date.now();
const dateien = fs.existsSync(ORDNER) ? fs.readdirSync(ORDNER).filter((f) => f.endsWith(".json")) : [];
let erledigt = 0;

for (const datei of dateien.sort()) {
  const pfad = path.join(ORDNER, datei);
  const woche = JSON.parse(fs.readFileSync(pfad, "utf8"));
  let geaendert = false;

  for (const post of woche.posts) {
    if (erledigt >= MAX_PRO_LAUF) break;
    if (NUR ? post.id !== NUR : post.status !== "geplant") continue;
    if (post.status === "test" && !TROCKEN) continue; // Testeinträge nie echt veröffentlichen
    const faellig = new Date(post.zeit).getTime();
    if (!NUR && faellig > jetzt) continue;

    if (!KANAELE[post.kanal]) {
      post.status = "manuell";
      geaendert = true;
      continue;
    }
    if (!NUR && jetzt - faellig > SPAETESTENS_STUNDEN * 3600_000) {
      post.status = "verpasst";
      geaendert = true;
      console.log(`verpasst: ${post.id}`);
      continue;
    }
    const fehlt = await erreichbar(post.medien || []);
    if (fehlt) {
      console.log(`warte: ${post.id}: ${fehlt}`);
      continue;
    }

    try {
      const r = await KANAELE[post.kanal](post);
      erledigt++;
      console.log(`${TROCKEN ? "geprüft" : "veröffentlicht"}: ${post.id} → ${r.link || r.id}`);
      if (!TROCKEN) {
        Object.assign(post, { status: "veroeffentlicht", veroeffentlicht_am: new Date().toISOString(), ergebnis: r });
        delete post.fehler;
        geaendert = true;
      }
    } catch (e) {
      erledigt++;
      console.error(`Fehler: ${post.id}: ${e.message}`);
      if (!TROCKEN) {
        post.versuche = (post.versuche || 0) + 1;
        post.fehler = e.message;
        if (post.versuche >= MAX_VERSUCHE) post.status = "fehler";
        geaendert = true;
      } else process.exitCode = 1;
    }
  }
  if (geaendert) fs.writeFileSync(pfad, JSON.stringify(woche, null, 2) + "\n");
}
if (!erledigt) console.log("Nichts fällig.");
