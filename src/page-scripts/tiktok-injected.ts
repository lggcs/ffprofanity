/**
 * TikTok Page Script - Injected via browser.scripting.executeScript with world: 'MAIN'
 *
 * TikTok's strict CSP (script-src without 'unsafe-inline') blocks the generic
 * composed inline interceptor, so caption detection runs here instead.
 *
 * TikTok architecture (verified live 2026-11-11):
 * - xgplayer plays via MSE (blob: src); the video element exposes NO native
 *   textTracks and captions are an HTML overlay shown only when the user
 *   enables CC in the player.
 * - WEBVTT caption files live on pre-signed CDN URLs published in JSON:
 *   hydration JSON (#__UNIVERSAL_DATA_FOR_REHYDRATION__, legacy #SIGI_STATE)
 *   carries captionInfos[] {language, languageCode, url, isAutoGen, ...};
 *   API/feed payloads may carry the older subtitleInfos[] shape
 *   {LanguageCodeName, Format, UrlList[]} instead.
 * - The caption URL has no file extension and a misleading video/mp4
 *   content-type but serves raw WEBVTT; fetch with credentials:'omit'
 *   succeeds cross-origin from the page context.
 * - This script fetches the WEBVTT and relays its content to the content
 *   script as FFPROFANITY_SUBTITLE_CONTENT. Content relay (not URL relay)
 *   is deliberate: the generic pipeline's URL-extension gates would reject
 *   these extension-less pre-signed links.
 */

(function () {
  'use strict';

  const w = window as any;
  if (w.__ffprofanityTikTokHooked__) return;
  w.__ffprofanityTikTokHooked__ = true;

  const EXTRACTOR_ID = 'tiktok';
  const sentKeys = new Set<string>();
  const inFlight = new Set<string>();

  function log(...args: unknown[]): void {
    console.log('[FFProfanity][' + EXTRACTOR_ID + ']', ...args);
  }

  const THREE_LETTER: Record<string, string> = {
    eng: 'en', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de',
    ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', kor: 'ko',
    cmn: 'zh', zho: 'zh', chi: 'zh', ara: 'ar', hin: 'hi',
    ind: 'id', vie: 'vi', tha: 'th', nld: 'nl', dut: 'nl',
    pol: 'pl', tur: 'tr', swe: 'sv',
  };

  function langToCode(raw: unknown): string {
    if (typeof raw !== 'string' || !raw) return 'unknown';
    const base = raw.split('-')[0]!.split('_')[0]!.toLowerCase();
    if (base.length === 2) return base;
    return THREE_LETTER[base] || base;
  }

  const LANG_NAMES: Record<string, string> = {
    en: 'English', es: 'Spanish', fr: 'French', de: 'German',
    it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese',
    ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi',
    id: 'Indonesian', vi: 'Vietnamese', th: 'Thai', nl: 'Dutch',
    pl: 'Polish', tr: 'Turkish', sv: 'Swedish',
  };

  function getLanguageName(code: string): string {
    return LANG_NAMES[code] || code.toUpperCase();
  }

  function isHttpUrl(u: unknown): boolean {
    return typeof u === 'string' && (u.indexOf('http://') === 0 || u.indexOf('https://') === 0);
  }

  function fetchAndRelay(url: string, language: string, label: string): void {
    if (sentKeys.has(url) || inFlight.has(url)) return;
    inFlight.add(url);
    fetch(url, { credentials: 'omit' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then((text) => {
        if (!text || text.indexOf('WEBVTT') !== 0) {
          log('Caption URL did not serve WEBVTT (' + (text ? text.slice(0, 40) : 'empty') + ')');
          return;
        }
        sentKeys.add(url);
        log('Relaying WEBVTT', text.length, 'bytes for', label);
        window.postMessage({
          type: 'FFPROFANITY_SUBTITLE_CONTENT',
          content: text,
          language,
          label,
          source: EXTRACTOR_ID + '.captions',
          url,
        }, '*');
      })
      .catch((e) => {
        log('Caption fetch failed:', e && e.message);
      })
      .finally(() => {
        inFlight.delete(url);
      });
  }

  function handleCaptionInfos(infos: any[]): void {
    for (const ci of infos) {
      if (!ci || typeof ci !== 'object') continue;
      let url = ci.url;
      if (!isHttpUrl(url) && Array.isArray(ci.urlList)) {
        url = ci.urlList.find((u: unknown) => isHttpUrl(u));
      }
      if (!isHttpUrl(url)) continue;
      const code = (typeof ci.languageCode === 'string' && ci.languageCode)
        ? ci.languageCode.toLowerCase()
        : langToCode(ci.language);
      const isAuto = ci.isAutoGen === true;
      fetchAndRelay(url, code, getLanguageName(code) + (isAuto ? ' (Auto)' : '') + ' (TikTok)');
    }
  }

  function handleSubtitleInfos(infos: any[]): void {
    for (const si of infos) {
      if (!si || typeof si !== 'object') continue;
      const list = Array.isArray(si.UrlList) ? si.UrlList
        : (Array.isArray(si.urlList) ? si.urlList : []);
      const url = list.find((u: unknown) => isHttpUrl(u));
      if (!isHttpUrl(url)) continue;
      const code = langToCode(si.LanguageCodeName || si.languageCodeName || si.language);
      fetchAndRelay(url, code, getLanguageName(code) + ' (TikTok)');
    }
  }

  // Recursively locate captionInfos/subtitleInfos in any parsed JSON
  function walkForCaptions(obj: unknown, depth: number): void {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    const rec = obj as Record<string, unknown>;
    if (Array.isArray(rec.captionInfos)) handleCaptionInfos(rec.captionInfos);
    if (Array.isArray(rec.subtitleInfos)) handleSubtitleInfos(rec.subtitleInfos);
    if (Array.isArray(obj)) {
      for (const item of obj) walkForCaptions(item, depth + 1);
    } else {
      for (const key in rec) {
        try {
          walkForCaptions(rec[key], depth + 1);
        } catch {
          // getter threw — not data, skip
        }
      }
    }
  }

  function scanHydration(): void {
    for (const id of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE']) {
      const el = document.getElementById(id);
      if (!el || !el.textContent) continue;
      try {
        walkForCaptions(JSON.parse(el.textContent), 0);
      } catch {
        // not JSON
      }
    }
  }

  function maybeScanResponseText(text: unknown, origin: string): void {
    if (!text || typeof text !== 'string' || text.length > 3000000) return;
    if (text.indexOf('captionInfos') === -1 && text.indexOf('subtitleInfos') === -1) return;
    try {
      walkForCaptions(JSON.parse(text), 0);
      log('Scanned ' + origin + ' response for captions');
    } catch {
      // not JSON
    }
  }

  // Feed navigation swaps videos without re-rendering hydration JSON, so
  // API responses are scanned for the per-video caption payloads too.
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: any, method: string, url: string | URL) {
    this._ffprofanity_url = url;
    return originalXHROpen.apply(this, arguments as any);
  };
  XMLHttpRequest.prototype.send = function (this: any) {
    const xhr = this;
    xhr.addEventListener('load', function () {
      if (xhr.responseType !== '' && xhr.responseType !== 'text') return;
      try {
        maybeScanResponseText(xhr.responseText, 'xhr(' + (xhr._ffprofanity_url || '') + ')');
      } catch {
        // ignore
      }
    });
    return originalXHRSend.apply(this, arguments as any);
  };

  const originalFetch = window.fetch;
  window.fetch = function (this: unknown) {
    const p = (originalFetch as any).apply(this, arguments as any) as Promise<Response>;
    try {
      p.then((response) => {
        try {
          const clone = response.clone();
          clone.text().then((t) => maybeScanResponseText(t, 'fetch')).catch(() => {});
        } catch {
          // clone unsupported
        }
      }).catch(() => {});
    } catch {
      // ignore
    }
    return p;
  } as typeof window.fetch;

  // Hydration can land after injection — scan immediately and retry.
  scanHydration();
  setTimeout(scanHydration, 1000);
  setTimeout(scanHydration, 3000);
  setTimeout(scanHydration, 7000);

  log('installed');
})();
