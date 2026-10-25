# TEMEL Studio · Social-Veröffentlicher

Veröffentlicht die freigegebenen Wochenpakete automatisch auf Instagram, Facebook und Threads.

- `warteschlange/JJJJ-KWnn.json` – Posts einer Woche (wird nach Emins Freigabe geschrieben)
- `medien/JJJJ-KWnn/` – Bilder (JPG) und Videos (MP4), öffentlich über GitHub Pages
- `scripts/veroeffentlichen.mjs` – läuft alle 15 Minuten (Action „Veröffentlichen“)

Ein Post: `{ "id", "kanal": "instagram|facebook|threads|linkedin|tiktok", "format": "bild|karussell|reel|story|text", "zeit": "2026-10-26T18:00:00+01:00", "text", "medien": ["medien/…"], "alt": ["…"], "status": "geplant" }`.
LinkedIn und TikTok werden als „manuell“ markiert, bis ihre Schnittstellen freigeschaltet sind.

Test ohne Veröffentlichen: Actions → Veröffentlichen → Run workflow (trocken = an, optional eine Post-ID).
