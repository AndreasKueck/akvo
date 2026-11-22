/*
 * hddu.gs – Version 4, UTC-Stundenwerte
 *
 * A: angezeigter UTC-Zeitstempel YYYY/MM/DD HH:mm
 * B: Wasserstand in Originaleinheit und Original-Höhenbezug
 *
 * INDEX -> EXTRACT -> ESTIMATE -> ASSIGN -> FIT
 *       -> CURVE_INIT -> CURVE_SAMPLE -> CURVE_FIT -> DONE
 *
 * INDEX legt eine Arbeitskopie auf dem Stundenraster an. Dadurch
 * müssen die Quellzeitstempel für die Ganglinien nicht erneut
 * eingelesen werden. Quellen während INDEX nicht verändern.
 *
 * Astronomy Engine steht in einer separaten Datei desselben Projekts.
 * Keine amtliche Gezeitenvorausberechnung.
 */

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RAD = Math.PI / 180;

const HD = {
  FIRST_ROW: 2,
  TIME_COLUMN: 1,
  LEVEL_COLUMN: 2,
  STEP_MS: HOUR,

  T0: Date.UTC(1949, 11, 31, 21, 8),
  SYNC_MINUTES: 24.23,
  MOON_DAY_H: 2 * 12.4206012,

  INDEX_ROWS: 4000,
  READ_BLOCK: 4000,       // Stundenpositionen, nicht Minuten
  ASSIGN_BLOCK: 350,
  EXTREME_HALF: 2,        // jeweils zwei Stunden links/rechts
  MAX_PLATEAU_STEPS: 1,   // zwei gleiche Messwerte: 1 h Plateaudauer
  HW_LAG_BRANCH_H: 17 + 20 / 60,
  MAX_ASSIGN_ERROR_H: 2.5,
  INVALID_LEVELS: [],     // bekannte numerische Fehlwertcodes eintragen

  STATE_KEY: 'HDDU_STATE_V4_UTC60',
  RESULT_KEY: 'HDDU_RESULT_ID_V4_UTC60'
};

const HD_SOURCES = loadHdSources_();

function loadHdSources_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const id = (props.HD_SOURCE_ID || '').trim();
  const gidText = (props.HD_SOURCE_GID || '').trim();

  if (!id) {
    throw new Error('Scripteigenschaft HD_SOURCE_ID fehlt oder ist leer.');
  }

  const gid = Number(gidText);
  if (!/^\d+$/.test(gidText) || !Number.isSafeInteger(gid)) {
    throw new Error(
      'HD_SOURCE_GID muss eine nichtnegative ganze Zahl sein, z. B. 358152738.'
    );
  }

  return [{
    label: '1965–1979',
    id: id,
    gid: gid,
    firstUTC: '1965-06-09T05:00:00Z',
    endUTC:   '1979-12-29T05:00:00Z'  // exklusiv
  }];
}

const HD_CURVE = {
  POINTS: 96,
  SAMPLE_DAYS: 20,       // Mondtage je Schreibblock
  MAX_OUTPUT_ROWS: 100000
};

// Boesch & Müller-Navarra (2019), Tab. 4: Grad/Transit, Rang.
// Der Satz wurde für HW/NW bestimmt; Verwendung für Ganglinien
// wie in der Vorlage in Verbindung mit Müller-Navarra (2013).
const HD_TERMS = [
  ['ZZZZAZ',0.0548098,6],   ['ZZZBZZ',0.2306165,13],
  ['ZZAZZZ',1.0201944,7],   ['ZZBXZZ',1.8097724,31],
  ['ZZBZZZ',2.0403886,17],  ['ZAXZZZ',11.5978420,14],
  ['ZAXAZZ',11.7131503,8],  ['ZAYXZZ',12.3874200,34],
  ['ZAYZZZ',12.6180365,19], ['ZAYAAZ',12.7881545,39],
  ['ZAZYZZ',13.5229227,3],  ['ZAZZZZ',13.6382309,4],
  ['ZAZZAZ',13.6930407,38], ['ZAZAZZ',13.7535391,21],
  ['ZABBAZ',15.9640460,36], ['ZBWZZZ',24.2158785,11],
  ['ZBXZYZ',25.1812631,35], ['ZBXZZZ',25.2360729,1],
  ['ZBYZZZ',26.2562673,12], ['ZBZXZZ',27.0458453,33],
  ['ZBZYZZ',27.1611535,15], ['ZBZZZZ',27.2764618,2],
  ['ZBZZAZ',27.3312716,27], ['ZCVAZZ',36.9492232,10],
  ['ZCXYZZ',38.7589956,16], ['ZCXZZZ',38.8743038,24],
  ['ZCXAZZ',38.9896120,22], ['ZCZYZZ',40.7993844,23],
  ['ZDUZZZ',49.4519514,29], ['ZDVZZZ',50.4721458,5],
  ['ZDXZZZ',52.5125347,9],  ['ZDXZAZ',52.5673444,37],
  ['ZDZZZZ',54.5529235,30], ['ZETAZZ',62.1852961,25],
  ['ZEVYZZ',63.9950685,28], ['ZEVAZZ',64.2256849,26],
  ['ZFTZZZ',75.7082187,20], ['ZFVZZZ',77.7486076,18],
  ['ZHRZZZ',100.9442917,32]
];

// -------------------- Zeit und Eingabewerte --------------------

function iso_(t) {
  return new Date(Math.round(t)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoMinute_(t) {
  return new Date(t).toISOString().slice(0, 16) + 'Z';
}

// Ausschließlich UTC; Rückvergleich verhindert stilles Überrollen
// von z.B. 31. Februar oder 24:00 auf den nächsten Tag.
function utcParts_(y, m, d, h, min, where) {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(h, min, 0, 0);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 ||
      date.getUTCDate() !== d || date.getUTCHours() !== h ||
      date.getUTCMinutes() !== min) {
    throw new Error(where + ': ungültiges Datum oder ungültige Uhrzeit.');
  }
  return date.getTime();
}

function sourceUTC_(value, where) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})(?::00)?$/.exec(text);
  if (!m) {
    throw new Error(where + ': "' + text +
      '" – erwartet wird YYYY/MM/DD HH:mm, z. B. 1965/06/09 05:00.');
  }
  return utcParts_(+m[1], +m[2], +m[3], +m[4], +m[5], where);
}

// Öffentliche Aufrufe unterstützen weiterhin die bisherigen Z-Formate.
// Zusätzlich ist das neue Quellformat ohne Z zulässig, ebenfalls als UTC.
function parseMinuteUTC_(value) {
  if (typeof value !== 'string') throw new Error('UTC-Zeit als Text angeben.');
  const text = value.trim();
  if (/^\d{4}\//.test(text)) {
    return sourceUTC_(text.replace(/Z$/, ''), text);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):?(\d{2})(?::00)?Z$/.exec(text);
  if (!m) throw new Error('Ungültiges UTC-Format: ' + text);
  return utcParts_(+m[1], +m[2], +m[3], +m[4], +m[5], text);
}

function parseUTCDate_(text) {
  const m = /^(\d{4})([-/])(\d{2})\2(\d{2})$/.exec(String(text));
  if (!m) throw new Error('Datum als YYYY-MM-DD oder YYYY/MM/DD angeben.');
  return utcParts_(+m[1], +m[3], +m[4], 0, 0, text);
}

function numericLevel_(value) {
  let x = value;
  if (typeof x === 'string') {
    x = x.trim().replace(',', '.');
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(x)) return NaN;
    x = Number(x);
  }
  return Number.isFinite(x) && !HD.INVALID_LEVELS.includes(x) ? x : NaN;
}

function check_(ok, msg) {
  if (!ok) throw new Error(msg);
}

// -------------------- Tabellen und Steuerung --------------------

function ensureSize_(sheet, rows, cols) {
  const r = sheet.getMaxRows(), c = sheet.getMaxColumns();
  if (cols > c) sheet.insertColumnsAfter(c, cols - c);
  if (rows > r) sheet.insertRowsAfter(r, rows - r);
}

function table_(out, name, headers) {
  let sheet = out.getSheetByName(name);
  if (!sheet) sheet = out.insertSheet(name);
  ensureSize_(sheet, 1, headers.length);
  if (sheet.getMaxColumns() > headers.length) {
    sheet.deleteColumns(headers.length + 1, sheet.getMaxColumns() - headers.length);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}

function put_(sheet, row, data, col) {
  if (!data.length) return;
  col = col || 1;
  ensureSize_(sheet, row + data.length - 1, col + data[0].length - 1);
  sheet.getRange(row, col, data.length, data[0].length).setValues(data);
}

function data_(out, name, cols) {
  const sheet = out.getSheetByName(name);
  const n = sheet.getLastRow() - 1;
  return n > 0 ? sheet.getRange(2, 1, n, cols).getValues() : [];
}

function props_() { return PropertiesService.getScriptProperties(); }

function loadState_() {
  return JSON.parse(props_().getProperty(HD.STATE_KEY) || 'null');
}

function saveState_(s) {
  props_().setProperty(HD.STATE_KEY, JSON.stringify(s));
}

function signature_() {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(['UTC60-v4.1', HD, HD_SOURCES, HD_CURVE, HD_TERMS]));
  return Utilities.base64Encode(bytes);
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'hdduWeiter') ScriptApp.deleteTrigger(t);
  });
}

function createTrigger_() {
  ScriptApp.newTrigger('hdduWeiter').timeBased().everyMinutes(1).create();
}

function locked_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function sourceSheet_(s) {
  const ss = SpreadsheetApp.openById(s.id);
  const sheet = ss.getSheets().find(x => x.getSheetId() === s.gid);
  check_(sheet, 'Quellblatt fehlt: ' + s.label);
  return sheet;
}

function manifest_() {
  let previousEnd = null;
  return HD_SOURCES.map(s => {
    const start = parseMinuteUTC_(s.firstUTC), end = parseMinuteUTC_(s.endUTC);
    check_(end > start && Number.isInteger((end - start) / HD.STEP_MS) &&
      (previousEnd === null || start === previousEnd),
      'Quellenintervalle müssen aneinander anschließen und ganze Stunden umfassen.');
    previousEnd = end;
    const sh = sourceSheet_(s);
    return Object.assign({}, s, {
      start, end, lastRow: sh.getLastRow(), capacity: (end - start) / HD.STEP_MS,
      zone: sh.getParent().getSpreadsheetTimeZone(),
      first: null, last: null, stamps: 0, valid: 0, empty: 0, gaps: 0
    });
  });
}

function hdduStart(vonUTC, bisUTC) {
  return locked_(() => {
    requireAstronomy_();
    const old = loadState_();
    check_(!old || old.stage === 'DONE', 'Analyse läuft bereits. Fortsetzen oder stoppen.');
    check_(HD_TERMS.length === 39 && HD.STEP_MS === HOUR, 'Konfiguration prüfen.');
    check_(Number.isInteger(HD_CURVE.POINTS) && HD_CURVE.POINTS >= 96 &&
      HD_CURVE.POINTS <= 288 && Number.isInteger(HD_CURVE.SAMPLE_DAYS) &&
      HD_CURVE.SAMPLE_DAYS > 0, 'Ungültige Ganglinienkonfiguration.');
    const sources = manifest_();
    check_(sources.length, 'Keine Quelle konfiguriert.');
    const origin = sources[0].start, limit = sources[sources.length - 1].end;
    const start = vonUTC === undefined ? origin : parseMinuteUTC_(vonUTC);
    const end = bisUTC === undefined ? limit : parseMinuteUTC_(bisUTC);
    check_(start >= origin && end <= limit && end - start >= 10000 * MINUTE,
      'Ungültiger oder zu kurzer Analysezeitraum.');
    check_(Number.isInteger((start - origin) / HD.STEP_MS) &&
      Number.isInteger((end - origin) / HD.STEP_MS),
      'Analysegrenzen müssen auf dem Stundenraster der Quelle liegen.');

    removeTriggers_();
    const out = SpreadsheetApp.create('HDdU UTC-Stundenwerte ' +
      Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm'));
    out.setSpreadsheetTimeZone('Etc/UTC');
    out.getSheets()[0].setName('Info');
    const info = table_(out, 'Info', ['Eigenschaft', 'Wert']);
    put_(info, 2, [
      ['Verfahren', 'HDdU V4 – UTC-Stundenwerte'],
      ['Analysebeginn UTC', iso_(start)], ['Analyseende UTC exklusiv', iso_(end)],
      ['Zeitbasis', 'Angezeigter Zeitstempel in A ist UTC'],
      ['Status', 'INDEX'], ['Messabstand Minuten', HD.STEP_MS / MINUTE],
      ['Ganglinienpunkte je Mondtag', HD_CURVE.POINTS],
      ['Höhenbezug', 'Originaleinheit und Höhenbezug der Quelle'],
      ['Lücken', 'Fehlende Stunden werden nicht überbrückt'],
      ['Stundenwerte', 'Zeile 2 = Analysebeginn, jede weitere Zeile +60 Minuten']
    ]);
    const qs = table_(out, 'Quellen', [
      'Quelle','Spreadsheet_ID','GID','Start_UTC','Ende_UTC_exklusiv',
      'Soll_Stunden','Physische_Zeilen','Tabellen_Zeitzone','Zeitstempel',
      'Gueltige_Wasserstaende','Leerzeilen','Fehlstunden_intern',
      'Fehlstunden_Anfang','Fehlstunden_Ende','Fehlstunden_gesamt',
      'Erster_Zeitstempel_UTC','Letzter_Zeitstempel_UTC'
    ]);
    put_(qs, 2, sources.map(s => [s.label, s.id, s.gid, s.firstUTC, s.endUTC,
      s.capacity, Math.max(0,s.lastRow-HD.FIRST_ROW+1), s.zone]));
    table_(out,'Zeitindex',['Quelle_Index','Startzeile','Zeilenzahl','Erste_UTC_ms',
      'Letzte_UTC_ms','Vorherige_UTC_ms','Zeitstempelzahl','Fehlstunden_intern']);
    const hourly = table_(out,'Stundenwerte',['Wasserstand_Originaleinheit']);
    const count = (end - start) / HD.STEP_MS;
    ensureSize_(hourly, count + 1, 1);
    table_(out,'Extrema',['UTC_ms','Art','Wasserstand']);
    table_(out,'Zuordnung',['Halbtransit_q','Transitnummer_n','k','Intervall_h',
      'Wasserstand','Ereignis_UTC_ms','Wahrer_Transit_UTC_ms','Zuordnungsfehler_h']);
    table_(out,'Modell',['k','JSON']);
    table_(out,'Koeffizienten',['k','Groesse','Doodson','Grad_pro_Transit',
      'Cos_Koeff','Sin_Koeff','Amplitude','Phase_Grad']);
    table_(out,'Diagnostik',['k','Zugeordnet','Verwendet','Glieder',
      'RMSE_Zeit_min','RMSE_Hoehe','Test_N','Test_RMSE_Zeit_min','Test_RMSE_Hoehe','Test_Glieder']);

    // Schreibpositionen gehören zum gespeicherten Zustand. Ein nach
    // einem Abbruch wiederholter Block schreibt an dieselbe Stelle.
    const s = {
      version: 4, signature: signature_(), stage:'INDEX', outputId:out.getId(),
      start, end, count, sources, src:0, srcRow:HD.FIRST_ROW, next:0,
      nextRow:{Zeitindex:2, Extrema:2, Zuordnung:2, Koeffizienten:2}
    };
    SpreadsheetApp.flush();
    saveState_(s);
    props_().setProperty(HD.RESULT_KEY, s.outputId);
    createTrigger_();
    console.log(out.getUrl());
    return out.getUrl();
  });
}

function append_(s, out, name, rows) {
  put_(out.getSheetByName(name), s.nextRow[name], rows);
  s.nextRow[name] += rows.length;
}

function hdduWeiter() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const s = loadState_();
    if (!s || s.stage === 'DONE') { removeTriggers_(); return; }
    check_(s.version === 4 && s.signature === signature_(),
      'Arbeitszustand und Konfiguration passen nicht zusammen.');
    const out = SpreadsheetApp.openById(s.outputId);
    // Nicht bestätigte Anhänge eines abgebrochenen Aufrufs entfernen.
    for (const name of Object.keys(s.nextRow)) {
      const sh = out.getSheetByName(name), n = sh.getLastRow() - s.nextRow[name] + 1;
      if (n > 0) sh.getRange(s.nextRow[name],1,n,sh.getMaxColumns()).clearContent();
    }
    const steps = {
      INDEX:indexBlock_, EXTRACT:extractBlock_, ESTIMATE:estimate_, ASSIGN:assignBlock_,
      FIT:fitClass_, CURVE_INIT:curveInit_, CURVE_SAMPLE:curveSample_,
      CURVE_FIT:curveFitStep_
    };
    check_(steps[s.stage], 'Unbekannte Stufe: ' + s.stage);
    steps[s.stage](s, out);
    delete s.lastError;
    out.getSheetByName('Info').getRange('B6').setValue(s.stage);
    SpreadsheetApp.flush();
    saveState_(s);
    if (s.stage === 'DONE') { removeTriggers_(); console.log(out.getUrl()); }
  } catch (err) {
    removeTriggers_();
    const s = loadState_();
    if (s) { s.lastError = String(err); saveState_(s); }
    throw err;
  } finally { lock.releaseLock(); }
}

function hdduFortsetzen() {
  return locked_(() => {
    const s = loadState_();
    check_(s && s.stage !== 'DONE', 'Keine unvollständige Analyse.');
    check_(s.signature === signature_(), 'Konfiguration wurde geändert.');
    delete s.lastError;
    saveState_(s);
    removeTriggers_();
    createTrigger_();
    console.log('Fortsetzung: ' + s.stage);
  });
}

function hdduStatus() {
  const s = loadState_();
  console.log(JSON.stringify(s, null, 2));
  if (s) console.log('https://docs.google.com/spreadsheets/d/' + s.outputId);
  return s;
}

function hdduStop() {
  return locked_(() => {
    removeTriggers_();
    props_().deleteProperty(HD.STATE_KEY);
    console.log('Gestoppt. Ergebnisdateien bleiben erhalten.');
  });
}

// -------------------- Stundenindex und Lücken --------------------

function acceptStamp_(src, t, where) {
  check_(t >= src.start && t < src.end, where + ': außerhalb des Quellenintervalls.');
  check_(Number.isInteger((t - src.start) / HD.STEP_MS),
    where + ': Zeitstempel außerhalb des 60-Minuten-Rasters: ' + iso_(t));
  if (src.last !== null) {
    check_(t > src.last, where + ': doppelter oder rückläufiger UTC-Zeitstempel.');
    src.gaps += (t - src.last) / HD.STEP_MS - 1;
  } else {
    src.first = t;
  }
  src.last = t;
  src.stamps++;
}

function indexBlock_(s, out) {
  const src = s.sources[s.src];
  const n = Math.min(HD.INDEX_ROWS, src.lastRow - s.srcRow + 1);
  if (n > 0) {
    const sh = sourceSheet_(src);
    const times = sh.getRange(s.srcRow,HD.TIME_COLUMN,n,1).getDisplayValues();
    const vals = sh.getRange(s.srcRow,HD.LEVEL_COLUMN,n,1).getValues();
    const oldLast = src.last, oldGaps = src.gaps, oldCount = src.stamps;
    let first = null, last = null, runStart = -1, run = [];
    const dest = out.getSheetByName('Stundenwerte');

    function flushRun() {
      if (run.length) put_(dest, runStart + 2, run);
      run = [];
    }

    for (let i = 0; i < n; i++) {
      const where = src.label + ', Zeile ' + (s.srcRow + i);
      const t = sourceUTC_(times[i][0], where), raw = vals[i][0];
      if (t === null) {
        check_(raw == null || String(raw).trim() === '',
          where + ': Wasserstand ohne Zeitstempel.');
        src.empty++;
        continue;
      }
      acceptStamp_(src,t,where);
      if (first === null) first = t;
      last = t;
      const h = numericLevel_(raw);
      if (Number.isFinite(h)) src.valid++;
      if (t < s.start || t >= s.end) continue;

      const pos = (t - s.start) / HD.STEP_MS;
      // Kleine Lücken in einem Schreibblock als leere Zellen schreiben;
      // bei großen Lücken keine riesigen temporären Arrays anlegen.
      if (run.length && pos - (runStart + run.length) > 100) flushRun();
      if (!run.length) runStart = pos;
      while (runStart + run.length < pos) run.push(['']);
      run.push([Number.isFinite(h) ? h : '']);
    }
    flushRun();
    append_(s,out,'Zeitindex',[[s.src,s.srcRow,n,first === null ? '' : first,
      last === null ? '' : last,oldLast === null ? '' : oldLast,
      src.stamps-oldCount,src.gaps-oldGaps]]);
    s.srcRow += n;
  }

  if (s.srcRow > src.lastRow) {
    const leading = src.first === null ? src.capacity : (src.first-src.start)/HD.STEP_MS;
    const trailing = src.last === null ? 0 : (src.end-HD.STEP_MS-src.last)/HD.STEP_MS;
    const missing = leading + src.gaps + trailing;
    check_(missing === src.capacity-src.stamps, 'Inkonsistente Stundenbilanz.');
    put_(out.getSheetByName('Quellen'), s.src+2, [[src.stamps,src.valid,src.empty,
      src.gaps,leading,trailing,missing,src.first === null ? '' : iso_(src.first),
      src.last === null ? '' : iso_(src.last)]], 9);
    s.src++;
    s.srcRow = HD.FIRST_ROW;
    if (s.src === s.sources.length) s.stage = 'EXTRACT';
  }
}

// [lo,hi) sind Stundenindizes relativ zum Analysebeginn.
function readHours_(s,out,lo,hi) {
  check_(Number.isInteger(lo) && Number.isInteger(hi) &&
    lo >= 0 && hi <= s.count && hi >= lo, 'Ungültiger Stundenbereich.');
  if (hi === lo) return [];
  return out.getSheetByName('Stundenwerte').getRange(lo+2,1,hi-lo,1)
    .getValues().map(r => Number.isFinite(r[0]) ? r[0] : NaN);
}

// -------------------- Scheitelpunkte --------------------

// Keine 11-Punkte-Glättung: Bei Stundenwerten entspräche diese
// fast einer ganzen halbtägigen Tide. Nur vollständige Fenster.
// Bei einem Einzelmaximum/-minimum: Parabel durch drei Stundenwerte.
// Bei gleich hohen Nachbarwerten: Mitte des kurzen Plateaus.
function peaks_(a, base, coreLo, coreHi, origin) {
  const w = HD.EXTREME_HALF, result = [];
  for (let i = 0; i < a.length;) {
    const first = i, y = a[i++];
    if (!Number.isFinite(y)) continue;
    while (i < a.length && a[i] === y) i++;
    const last = i-1;
    if (last-first > HD.MAX_PLATEAU_STEPS ||
        first < w || last+w >= a.length) continue;
    const owner = base+first;
    if (owner < coreLo || owner >= coreHi) continue;
    let high = true, low = true;
    for (let j = 1; j <= w; j++) {
      const l = a[first-j], r = a[last+j];
      high = high && l < y && r < y;
      low  = low  && l > y && r > y;
    }
    if (!high && !low) continue;
    let index = (first+last)/2, height = y;
    if (first === last) {
      const l = a[first-1], r = a[first+1], c = l-2*y+r;
      const dx = (l-r)/(2*c);
      if (Number.isFinite(dx) && Math.abs(dx) <= 0.5) {
        index = first+dx;
        height = y-(r-l)*(r-l)/(8*c);
      }
    }
    result.push([origin+(base+index)*HD.STEP_MS,high ? 'HW' : 'NW',height]);
  }
  return result;
}

function extractBlock_(s,out) {
  const end = Math.min(s.count,s.next+HD.READ_BLOCK);
  const pad = HD.EXTREME_HALF+HD.MAX_PLATEAU_STEPS+2;
  const lo = Math.max(0,s.next-pad), hi = Math.min(s.count,end+pad);
  append_(s,out,'Extrema',peaks_(readHours_(s,out,lo,hi),lo,s.next,end,s.start));
  s.next = end;
  if (end === s.count) s.stage = 'ESTIMATE';
}

// -------------------- Mondtransite und Zuordnung --------------------

function meanUpper_(n) {
  return HD.T0 + HD.SYNC_MINUTES*MINUTE + n*HD.MOON_DAY_H*HOUR;
}

function meanHalf_(q) { return meanUpper_(q/2); }
function wrap180_(x) { return ((x+180)%360+360)%360-180; }

function requireAstronomy_() {
  check_(typeof Astronomy !== 'undefined','Astronomy Engine fehlt.');
  for (const f of ['AstroTime','GeoMoon','RotateVector','Rotation_EQJ_EQD',
                    'EquatorFromVector','SiderealTime']) {
    check_(typeof Astronomy[f] === 'function','Astronomy.'+f+' fehlt.');
  }
}

function moonHourAngle_(ms) {
  const t = new Astronomy.AstroTime(new Date(ms));
  const v = Astronomy.RotateVector(Astronomy.Rotation_EQJ_EQD(t),Astronomy.GeoMoon(t));
  return wrap180_(15*(Astronomy.SiderealTime(t)-Astronomy.EquatorFromVector(v).ra));
}

function trueTransit_(q,cache) {
  if (cache.has(q)) return cache.get(q);
  const target = q%2 ? 180 : 0;
  let t = meanHalf_(q);
  for (let i = 0; i < 10; i++) {
    const error = wrap180_(moonHourAngle_(t)-target), dt = 5*MINUTE;
    const speed = wrap180_(moonHourAngle_(t+dt)-moonHourAngle_(t-dt))/(2*dt/HOUR);
    check_(speed > 10 && speed < 20,'Unplausible Mondgeschwindigkeit.');
    const corr = error/speed*HOUR;
    t -= corr;
    if (Math.abs(corr) < 100) break;
  }
  check_(Math.abs(wrap180_(moonHourAngle_(t)-target)) <= 0.001 &&
    Math.abs(t-meanHalf_(q)) <= 4*HOUR,'Unsicherer Mondtransit q='+q);
  cache.set(q,t);
  return t;
}

function circularLag_(rows,branch) {
  const half = HD.MOON_DAY_H/2;
  let c = 0, s = 0;
  for (const r of rows) {
    const a = 2*Math.PI*(r[0]-meanUpper_(0))/(HOUR*half);
    c += Math.cos(a); s += Math.sin(a);
  }
  let lag = Math.atan2(s,c)*half/(2*Math.PI);
  lag += Math.round((branch-lag)/half)*half;
  return {lag, coherence:Math.hypot(c,s)/Math.max(1,rows.length)};
}

function intervals_(out) {
  const rows = data_(out,'Extrema',3);
  const highs = rows.filter(r=>r[1]==='HW'), lows = rows.filter(r=>r[1]==='NW');
  const HW = circularLag_(highs,HD.HW_LAG_BRANCH_H);
  const NW = circularLag_(lows,HW.lag+HD.MOON_DAY_H/4);
  return {anzahlHW:highs.length,anzahlNW:lows.length,HW,NW,abstandHWzuNW_h:NW.lag-HW.lag};
}

function hdduDiagnoseIntervalle() {
  const r = intervals_(SpreadsheetApp.openById(resultId_()));
  console.log(JSON.stringify(r,null,2));
  return r;
}

function estimate_(s,out) {
  const r = intervals_(out);
  s.eventCount = r.anzahlHW+r.anzahlNW;
  check_(s.eventCount >= 200 && r.HW.coherence >= 0.5 && r.NW.coherence >= 0.5,
    'Keine ausreichend eindeutige halbtägige Scheitelpunktfolge: '+JSON.stringify(r));
  check_(r.abstandHWzuNW_h > 2 && r.abstandHWzuNW_h < 11,'Unplausible Ebbedauer.');
  s.hw = r.HW.lag; s.nw = r.NW.lag; s.event = 0;
  put_(out.getSheetByName('Info'),13,[
    ['HW-Intervall h',s.hw],['NW-Intervall h',s.nw],
    ['HW-Kohärenz',r.HW.coherence],['NW-Kohärenz',r.NW.coherence]
  ]);
  s.stage = 'ASSIGN';
}

function assignBlock_(s,out) {
  const size = Math.min(HD.ASSIGN_BLOCK,s.eventCount-s.event);
  const rows = out.getSheetByName('Extrema').getRange(s.event+2,1,size,3).getValues();
  const cache = new Map(), assigned = [];
  for (const [time,type,height] of rows) {
    const high = type === 'HW', lag = high ? s.hw : s.nw;
    const q0 = Math.round((time-meanUpper_(0)-lag*HOUR)/(HD.MOON_DAY_H*HOUR/2));
    let best = null;
    for (let q = q0-1; q <= q0+1; q++) {
      const transit = trueTransit_(q,cache), error = Math.abs((time-transit)/HOUR-lag);
      if (!best || error < best.error) best = {q,transit,error};
    }
    if (best.error > HD.MAX_ASSIGN_ERROR_H) continue;
    const n = Math.floor(best.q/2), k = 1+2*(best.q-2*n)+(high ? 0 : 1);
    assigned.push([best.q,n,k,(time-meanUpper_(n))/HOUR,height,time,best.transit,best.error]);
  }
  append_(s,out,'Zuordnung',assigned);
  s.event += size;
  if (s.event === s.eventCount) { s.stage='FIT'; s.k=1; }
}

// -------------------- Statistik und Householder-QR --------------------

// Beobachtung: { n: Transitnummer, y: [Intervall,h] oder [h] }.
// Alle Reihen werden vor der Anpassung nach n sortiert übergeben.
function termsFor_(rows) {
  check_(rows.length >= 2,'Zu wenige Beobachtungen.');
  const span = rows[rows.length-1].n-rows[0].n;
  check_(span > 60,'Zu kurze Transitspanne.');
  const resolution = 360/span, terms = [];
  for (const t of HD_TERMS.slice().sort((a,b)=>a[2]-b[2])) {
    if (t[1] >= resolution && terms.every(v=>Math.abs(t[1]-v[1]) >= resolution)) {
      terms.push(t);
    }
  }
  return terms.sort((a,b)=>a[1]-b[1]);
}

function basis_(n,terms) {
  const v = [1];
  for (const t of terms) {
    const a = ((t[1]*n)%360)*RAD;
    v.push(Math.cos(a),Math.sin(a));
  }
  return v;
}

function evaluate_(n,terms,c) {
  let v = c[0];
  for (let i = 0; i < terms.length; i++) {
    const a = ((terms[i][1]*n)%360)*RAD;
    v += c[2*i+1]*Math.cos(a)+c[2*i+2]*Math.sin(a);
  }
  return v;
}

function mean_(a) { return a.reduce((s,v)=>s+v,0)/a.length; }
function rmse_(a) { return Math.sqrt(mean_(a.map(v=>v*v))); }

function clip_(rows,values) {
  if (!rows.length) return [];
  const limits = values[0].map((_,j)=>{
    const a = values.map(v=>v[j]), m = mean_(a);
    const sd = Math.sqrt(a.reduce((s,v)=>s+(v-m)*(v-m),0)/Math.max(1,a.length-1));
    return [m,Math.max(3*sd,1e-10)];
  });
  return rows.filter((r,i)=>values[i].every((v,j)=>Math.abs(v-limits[j][0])<=limits[j][1]));
}

// Spaltenweise Speicherung: Householder-QR ohne Normalgleichungen.
// Gemeinsame Faktorisierung für Zeit und Höhe bei Ereignismodellen.
function fit_(rows) {
  const terms = termsFor_(rows), m = rows.length, p = 1+2*terms.length;
  check_(m >= Math.max(100,3*p),'Zu wenige Beobachtungen für '+terms.length+' Glieder.');
  const ny = rows[0].y.length;
  const cols = Array.from({length:p+ny},()=>new Float64Array(m));
  for (let i = 0; i < m; i++) {
    const v = basis_(rows[i].n,terms);
    for (let j = 0; j < p; j++) cols[j][i] = v[j];
    for (let j = 0; j < ny; j++) cols[p+j][i] = rows[i].y[j];
  }
  for (let k = 0; k < p; k++) {
    const v = cols[k];
    let norm2 = 0;
    for (let i = k; i < m; i++) norm2 += v[i]*v[i];
    const norm = Math.sqrt(norm2);
    check_(norm > 1e-9*Math.sqrt(m),'Numerisch nicht trennbare Modellspalten.');
    const alpha = v[k] >= 0 ? -norm : norm;
    v[k] -= alpha;
    const beta = -1/(alpha*v[k]);
    for (let j = k+1; j < cols.length; j++) {
      const c = cols[j];
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i]*c[i];
      dot *= beta;
      for (let i = k; i < m; i++) c[i] -= dot*v[i];
    }
    v[k] = alpha;
  }
  const coef = [];
  for (let j = 0; j < ny; j++) {
    const x = new Array(p);
    for (let i = p-1; i >= 0; i--) {
      let z = cols[p+j][i];
      for (let k = i+1; k < p; k++) z -= cols[k][i]*x[k];
      x[i] = z/cols[i][i];
    }
    coef.push(x);
  }
  return {terms,coef};
}

function errors_(rows,f) {
  return rows.map(r=>r.y.map((y,j)=>y-evaluate_(r.n,f.terms,f.coef[j])));
}

function initialRows_(rows) { return clip_(rows,rows.map(r=>r.y)); }

function finalFit_(rows,first) {
  const initial = initialRows_(rows);
  const used = clip_(initial,errors_(initial,first));
  const f = fit_(used), err = errors_(used,f);
  return Object.assign(f,{
    usedCount:used.length,nMin:used[0].n,nMax:used[used.length-1].n,
    rmse:f.coef.map((_,j)=>rmse_(err.map(v=>v[j])))
  });
}

function robustFit_(rows) { return finalFit_(rows,fit_(initialRows_(rows))); }

function validation_(test,f) {
  const errors = errors_(test,f);
  return {n:test.length,terms:f.terms.length,
    rmse:f.coef.map((_,j)=>rmse_(errors.map(v=>v[j]))),
    bias:f.coef.map((_,j)=>mean_(errors.map(v=>v[j])))};
}

function emptyValidation_(ny) {
  return {n:0,terms:null,rmse:Array(ny).fill(null),bias:Array(ny).fill(null)};
}

function cell_(v) { return v == null ? '' : v; }

function fitClass_(s,out) {
  const unique = new Map();
  for (const r of data_(out,'Zuordnung',8)) {
    const key = r[1]+':'+r[2];
    if (!unique.has(key) || r[7] < unique.get(key)[7]) unique.set(key,r);
  }
  const invalid = new Set();
  for (const [key,r] of unique) {
    if (r[2] !== 1 && r[2] !== 3) continue;
    const lowKey = r[1]+':'+(r[2]+1), low = unique.get(lowKey);
    if (low) {
      const duration = (low[5]-r[5])/HOUR;
      if (!(duration > 2 && duration < 11)) { invalid.add(key); invalid.add(lowKey); }
    }
  }
  const rows = [];
  for (const [key,r] of unique) {
    if (r[2] === s.k && !invalid.has(key)) rows.push({n:r[1],y:[r[3],r[4]],time:r[5]});
  }
  rows.sort((a,b)=>a.n-b.n);
  check_(rows.length >= 200,'Zu wenige Daten für Ereignisklasse k='+s.k);
  const last = rows[rows.length-1], cutoff = rows[0].n+0.8*(last.n-rows[0].n);
  const train = rows.filter(r=>r.n<=cutoff), test = rows.filter(r=>r.n>cutoff);
  const v = train.length>=200 && test.length>=40 ?
    validation_(test,robustFit_(train)) : emptyValidation_(2);
  const f = robustFit_(rows);
  const model = {
    version:4,basis:'MEAN_UPPER_TRANSIT_2013',k:s.k,t0:HD.T0,
    syncMinutes:HD.SYNC_MINUTES,moonDayHours:HD.MOON_DAY_H,
    terms:f.terms,time:f.coef[0],height:f.coef[1],nMin:f.nMin,nMax:f.nMax,
    usedCount:f.usedCount,inputStartUTC:iso_(rows[0].time),inputEndUTC:iso_(last.time),
    trainingTimeRMSEmin:60*f.rmse[0],trainingHeightRMSE:f.rmse[1],
    validation:{n:v.n,timeRMSEmin:v.n ? 60*v.rmse[0] : null,
      heightRMSE:v.rmse[1],terms:v.terms}
  };
  put_(out.getSheetByName('Modell'),s.k+1,[[s.k,JSON.stringify(model)]]);
  const coeffRows = [];
  for (const [name,c] of [['Zeit_h',model.time],['Hoehe_Originaleinheit',model.height]]) {
    coeffRows.push([s.k,name,'MITTEL',0,c[0],0,'','']);
    f.terms.forEach((t,j)=>{
      const a=c[2*j+1], b=c[2*j+2];
      coeffRows.push([s.k,name,t[0],t[1],a,b,Math.hypot(a,b),(Math.atan2(b,a)/RAD+360)%360]);
    });
  }
  append_(s,out,'Koeffizienten',coeffRows);
  put_(out.getSheetByName('Diagnostik'),s.k+1,[[s.k,rows.length,f.usedCount,f.terms.length,
    60*f.rmse[0],f.rmse[1],v.n,cell_(model.validation.timeRMSEmin),cell_(v.rmse[1]),cell_(v.terms)]]);
  if (++s.k > 4) s.stage = 'CURVE_INIT';
}

// -------------------- Ganglinie --------------------

function curveInit_(s,out) {
  const points = HD_CURVE.POINTS, moonDayMs = HD.MOON_DAY_H*HOUR;
  const stepMs = moonDayMs/points, originMs = meanUpper_(0)+s.hw*HOUR+stepMs/2;
  const nFirst = Math.floor((s.start-originMs)/moonDayMs);
  const nLast = Math.floor((s.end-1-originMs)/moonDayMs);
  const headers = Array.from({length:points},(_,i)=>'Wasserstand_k'+(i+1));
  const sh = table_(out,'Ganglinie_Daten',['Transitnummer_n'].concat(headers));
  ensureSize_(sh,nLast-nFirst+2,points+1);
  table_(out,'Ganglinie_Modell',['k','JSON']);
  table_(out,'Ganglinie_Diagnostik',['k','Vorhanden','Verwendet','Glieder',
    'Anpassungs_RMSE','Test_N','Test_RMSE','Test_Bias','Test_Glieder','Belegung_Anteil']);
  table_(out,'Ganglinie_Meta',['Eigenschaft','JSON']);
  s.curve = {version:4,complete:false,points,moonDayMs,stepMs,originMs,nFirst,nLast,
    hwLagHours:s.hw,t0:HD.T0,syncMinutes:HD.SYNC_MINUTES,moonDayHours:HD.MOON_DAY_H,
    sourceStepMinutes:HD.STEP_MS/MINUTE,sourceTimeHandling:'UTC, YYYY/MM/DD HH:mm',
    analysisStartUTC:iso_(s.start),analysisEndUTCExclusive:iso_(s.end),
    interpolation:'Linear nur zwischen benachbarten gültigen Stundenwerten',
    unit:'Originaleinheit der Quellspalte B'};
  writeMeta_(s,out);
  s.curveN=nFirst; s.stage='CURVE_SAMPLE';
}

function writeMeta_(s,out) {
  put_(out.getSheetByName('Ganglinie_Meta'),2,[['Metadaten',JSON.stringify(s.curve)]]);
}

function sampleTime_(m,n,k) {
  return m.originMs+n*m.moonDayMs+k*m.stepMs; // k hier nullbasiert
}

function interpolateHours_(a,pos) {
  if (pos < 0 || pos > a.length-1) return NaN;
  const i = Math.floor(pos), f = pos-i, l = a[i];
  if (f === 0) return l;
  const r = a[i+1];
  return Number.isFinite(l) && Number.isFinite(r) ? l+f*(r-l) : NaN;
}

function curveSample_(s,out) {
  const m=s.curve, first=s.curveN, last=Math.min(m.nLast,first+HD_CURVE.SAMPLE_DAYS-1);
  const lo=Math.max(0,Math.min(s.count,Math.floor((sampleTime_(m,first,0)-s.start)/HD.STEP_MS)));
  const hi=Math.max(lo,Math.min(s.count,
    Math.ceil((sampleTime_(m,last,m.points-1)-s.start)/HD.STEP_MS)+1));
  const a=readHours_(s,out,lo,hi), rows=[];
  for (let n=first;n<=last;n++) {
    const row=[n];
    for (let k=0;k<m.points;k++) {
      const t=sampleTime_(m,n,k);
      const h=t>=s.start && t<s.end ? interpolateHours_(a,(t-s.start)/HD.STEP_MS-lo) : NaN;
      row.push(Number.isFinite(h) ? h : '');
    }
    rows.push(row);
  }
  put_(out.getSheetByName('Ganglinie_Daten'),2+first-m.nFirst,rows);
  s.curveN=last+1;
  if (s.curveN>m.nLast) { s.k=1; s.pass='TRAIN_FIRST'; s.stage='CURVE_FIT'; }
}

// Nur eine QR-Ausgleichung pro Ganglinien-Triggeraufruf.
function curveFitStep_(s,out) {
  const m=s.curve, nRows=m.nLast-m.nFirst+1;
  const col=out.getSheetByName('Ganglinie_Daten').getRange(2,s.k+1,nRows,1).getValues();
  const rows=[];
  col.forEach(([h],i)=>{ if (Number.isFinite(h)) rows.push({n:m.nFirst+i,y:[h]}); });
  check_(rows.length>=200,'Zu wenige Ganglinienwerte für k='+s.k);
  const cut=m.nFirst+0.8*(m.nLast-m.nFirst);
  const train=rows.filter(r=>r.n<=cut), test=rows.filter(r=>r.n>cut);
  switch (s.pass) {
    case 'TRAIN_FIRST':
      s.validation=emptyValidation_(1);
      if (train.length>=200 && test.length>=40) {
        s.pre=fit_(initialRows_(train)); s.pass='TRAIN_SECOND';
      } else s.pass='FINAL_FIRST';
      break;
    case 'TRAIN_SECOND':
      s.validation=validation_(test,finalFit_(train,s.pre));
      delete s.pre; s.pass='FINAL_FIRST';
      break;
    case 'FINAL_FIRST':
      s.pre=fit_(initialRows_(rows)); s.pass='FINAL_SECOND';
      break;
    case 'FINAL_SECOND': {
      const f=finalFit_(rows,s.pre), v=s.validation;
      const model={version:4,kind:'HDDU_HYDROGRAPH',k:s.k,terms:f.terms,height:f.coef[0],
        nMin:f.nMin,nMax:f.nMax,availableCount:rows.length,usedCount:f.usedCount,
        trainingHeightRMSE:f.rmse[0],validation:{n:v.n,rmse:v.rmse[0],bias:v.bias[0],terms:v.terms}};
      put_(out.getSheetByName('Ganglinie_Modell'),s.k+1,[[s.k,JSON.stringify(model)]]);
      put_(out.getSheetByName('Ganglinie_Diagnostik'),s.k+1,[[s.k,rows.length,f.usedCount,
        f.terms.length,f.rmse[0],v.n,cell_(v.rmse[0]),cell_(v.bias[0]),cell_(v.terms),rows.length/nRows]]);
      delete s.pre; delete s.validation;
      s.pass='TRAIN_FIRST';
      if (++s.k>m.points) {
        m.complete=true; m.finishedUTC=iso_(Date.now()); writeMeta_(s,out);
        put_(out.getSheetByName('Info'),17,[
          ['Fertig UTC',m.finishedUTC],
          ['Validierung','Testdaten liegen zeitlich nach den Trainingsdaten.'],
          ['Auflösung','Unterstündliche Ganglinienwerte und Scheitelzeiten sind Schätzungen.'],
          ['Gültigkeit','Astronomische Gezeiten; kein Windstau und keine Abflusskorrektur.']
        ]);
        s.stage='DONE';
      }
      break;
    }
    default: throw new Error('Unbekannter Fit-Schritt: '+s.pass);
  }
}

// -------------------- Vorhersage: HW/NW und Transite --------------------

function resultId_(id) {
  const value=id || props_().getProperty(HD.RESULT_KEY);
  check_(value,'Keine UTC60-Ergebnisdatei vorhanden.');
  return value;
}

function greenwichTransitsBetween_(start,end,cache) {
  const half=HD.MOON_DAY_H*HOUR/2, events=[];
  const first=Math.floor((start-meanUpper_(0))/half)-2;
  const last=Math.ceil((end-meanUpper_(0))/half)+2;
  for (let q=first;q<=last;q++) {
    const t=trueTransit_(q,cache);
    if (t>=start && t<end) events.push({art:q%2 ? 'unterer':'oberer',
      utc:iso_(t),transitnummer:Math.floor(q/2)});
  }
  return events;
}

function greenwichMondtransiteUTC(datum) {
  requireAstronomy_();
  const t=parseUTCDate_(datum);
  return greenwichTransitsBetween_(t,t+DAY,new Map());
}

function modelWarnings_(models,start,end,from,to) {
  const w=[
    'Wasserstand in Originaleinheit und Höhenbezug der Quelle.',
    'Astronomische Gezeiten; kein Windstau und keine aktuelle Abflusskorrektur.',
    'Eingangsdaten: Stundenwerte. Unterstündliche Angaben sind Modellschätzungen.'
  ];
  const span=Math.min(...models.map(m=>(m.nMax-m.nMin)*HD.MOON_DAY_H/24/365.2425));
  if (span<9) w.push('Unter neun Jahre: Referenzpegelanalyse fachlich prüfen.');
  else if (span<18.6133) w.push('Die Modellreihen decken nicht alle eine Mondknotenperiode ab.');
  if (models.some(m=>m.terms.length<39)) w.push('Nicht alle 39 Glieder sind auflösbar.');
  if (start<from || end>=to) w.push('Abfrage enthält zeitliche Extrapolation.');
  if (end>to+365.2425*DAY) w.push('Mehr als ein Jahr nach Analyseende: Pegelregime und Höhenbezug prüfen.');
  return w;
}

function vorhersageUTC(datum,ergebnisDateiId) {
  requireAstronomy_();
  const start=parseUTCDate_(datum), end=start+DAY, id=resultId_(ergebnisDateiId);
  const out=SpreadsheetApp.openById(id), sh=out.getSheetByName('Modell');
  check_(sh,'Blatt Modell fehlt.');
  const models=sh.getRange(2,2,4,1).getValues().map(([text],i)=>{
    check_(text,'Scheitelpunktmodell fehlt: k='+(i+1));
    const m=JSON.parse(text);
    check_(m.version===4 && m.k===i+1 && m.basis==='MEAN_UPPER_TRANSIT_2013' &&
      m.t0===HD.T0 && m.syncMinutes===HD.SYNC_MINUTES && m.moonDayHours===HD.MOON_DAY_H,
      'Unpassende Zeitbasis oder Modellversion.');
    return m;
  });
  const cache=new Map(), events=[], md=HD.MOON_DAY_H*HOUR;
  const first=Math.floor((start-meanUpper_(0))/md)-4;
  const last=Math.ceil((end-meanUpper_(0))/md)+4;
  for (let n=first;n<=last;n++) for (const m of models) {
    const lag=evaluate_(n,m.terms,m.time);
    check_(Number.isFinite(lag) && Math.abs(lag)<=72,'Unplausibles Ereignisintervall.');
    const t=meanUpper_(n)+lag*HOUR;
    if (t<start || t>=end) continue;
    const lower=m.k>=3, q=2*n+(lower?1:0);
    events.push({art:m.k%2?'HW':'NW',utc:iso_(t),wasserstand:evaluate_(n,m.terms,m.height),
      transitnummer:n,k:m.k,zugeordneterTransit:lower?'unterer':'oberer',
      transitUTC:iso_(trueTransit_(q,cache)),verwendeteKonstituenten:m.terms.length});
  }
  events.sort((a,b)=>a.utc.localeCompare(b.utc));
  const warnings=modelWarnings_(models,start,end-1,
    Math.max(...models.map(m=>Date.parse(m.inputStartUTC))),
    Math.min(...models.map(m=>Date.parse(m.inputEndUTC)))+1);
  if (events.some((v,i)=>i>0 && events[i-1].art===v.art)) {
    warnings.push('Nicht alternierende HW/NW-Folge: Modell prüfen.');
  }
  return {datumUTC:datum,ergebnisDateiId:id,ereignisse:events,
    greenwichTransite:greenwichTransitsBetween_(start,end,cache),hinweise:warnings};
}

// -------------------- Vorhersage: Ganglinie --------------------

function loadCurveModels_(id) {
  id=resultId_(id);
  const out=SpreadsheetApp.openById(id), metaSheet=out.getSheetByName('Ganglinie_Meta');
  check_(metaSheet,'Ganglinienanalyse fehlt.');
  const meta=JSON.parse(metaSheet.getRange('B2').getValue() || 'null');
  check_(meta && meta.complete && meta.version===4 && meta.sourceStepMinutes===60 &&
    Number.isInteger(meta.points) && meta.points>0 && Number.isFinite(meta.originMs) &&
    meta.stepMs>0,'Kein vollständiges UTC60-Ganglinienmodell.');
  const models=out.getSheetByName('Ganglinie_Modell').getRange(2,2,meta.points,1)
    .getValues().map(([text],i)=>{
      const m=JSON.parse(text || 'null');
      check_(m && m.version===4 && m.kind==='HDDU_HYDROGRAPH' && m.k===i+1 &&
        Array.isArray(m.terms) && m.terms.every(t=>Array.isArray(t)&&Number.isFinite(t[1])) &&
        Array.isArray(m.height) && m.height.length===1+2*m.terms.length &&
        m.height.every(Number.isFinite),'Ungültiges Ganglinienmodell k='+(i+1));
      return m;
    });
  return {id,meta,models};
}

function curveValueAt_(t,b,cache) {
  const pos=(t-b.meta.originMs)/b.meta.stepMs, i=Math.floor(pos);
  function grid(j) {
    if (!cache.has(j)) {
      const n=Math.floor(j/b.meta.points), m=b.models[j-n*b.meta.points];
      const h=evaluate_(n,m.terms,m.height);
      check_(Number.isFinite(h),'Nicht endlicher Modellwert.');
      cache.set(j,h);
    }
    return cache.get(j);
  }
  const a=grid(i);
  return a+(pos-i)*(grid(i+1)-a);
}

function curveInfo_(b,start,end) {
  const m=b.meta;
  const warnings=modelWarnings_(b.models,start,end,
    Date.parse(m.analysisStartUTC),Date.parse(m.analysisEndUTCExclusive));
  warnings.push('Modellstützstellen im Abstand von '+(m.stepMs/MINUTE).toFixed(4)+
    ' Minuten; beim Training nur zwischen benachbarten gültigen Stundenwerten interpoliert.');
  if (b.models.some(v=>v.availableCount/(m.nLast-m.nFirst+1)<0.6)) {
    warnings.push('Mindestens eine Stützstellenreihe hat unter 60 % Belegung.');
  }
  return {einheit:m.unit,methode:'HDdU-Ganglinie mit linearer Stützstelleninterpolation',
    stuetzstellenJeMondtag:m.points,stuetzstellenAbstandMinuten:m.stepMs/MINUTE,
    ergebnisDateiId:b.id,hinweise:warnings};
}

function wasserstandUTC(zeitUTC,ergebnisDateiId) {
  const t=parseMinuteUTC_(zeitUTC), b=loadCurveModels_(ergebnisDateiId);
  return Object.assign(curveInfo_(b,t,t),{
    utc:isoMinute_(t),wasserstand:curveValueAt_(t,b,new Map())});
}

function wasserstandZeitraumUTC(vonUTC,bisUTC,schrittMinuten,ergebnisDateiId) {
  const start=parseMinuteUTC_(vonUTC), end=parseMinuteUTC_(bisUTC);
  const step=schrittMinuten===undefined ? 1 : schrittMinuten;
  check_(Number.isInteger(step) && step>=1 && end>=start,'Ungültiger Ausgabezeitraum oder Schritt.');
  const count=Math.floor((end-start)/(step*MINUTE))+1;
  check_(count<=HD_CURVE.MAX_OUTPUT_ROWS,'Zu viele Ausgabewerte. Zeitraum aufteilen.');
  const b=loadCurveModels_(ergebnisDateiId), cache=new Map(), values=[];
  for (let i=0;i<count;i++) {
    const t=start+i*step*MINUTE;
    values.push({utc:isoMinute_(t),wasserstand:curveValueAt_(t,b,cache)});
  }
  return Object.assign(curveInfo_(b,start,end),{vonUTC:isoMinute_(start),
    bisUTC:isoMinute_(end),schrittMinuten:step,werte:values});
}

// -------------------- Ausgabe und Beispiele --------------------

function writePrediction_(r) {
  const out=SpreadsheetApp.openById(r.ergebnisDateiId);
  const headers=['Art','Ereignis UTC','Wasserstand_Originaleinheit','Transitart','Transit UTC','Transitnummer'];
  const sh=table_(out,'Vorhersage',headers);
  sh.clearContents();
  const rows=[['Datum UTC',r.datumUTC,'','','',''],headers];
  r.ereignisse.forEach(e=>rows.push([e.art,e.utc,e.wasserstand,e.zugeordneterTransit,e.transitUTC,e.transitnummer]));
  rows.push(['Greenwich-Transite','','','','','']);
  r.greenwichTransite.forEach(e=>rows.push([e.art,e.utc,'','','',e.transitnummer]));
  r.hinweise.forEach(w=>rows.push(['Hinweis',w,'','','','']));
  put_(sh,1,rows);
}

function schreibeWasserstand_(r) {
  const out=SpreadsheetApp.openById(r.ergebnisDateiId);
  const headers=['UTC','Wasserstand_Originaleinheit'];
  const sh=table_(out,'Wasserstand_Vorhersage',headers);
  sh.clearContents();
  const rows=[headers];
  (r.werte || [r]).forEach(v=>rows.push([v.utc,v.wasserstand]));
  r.hinweise.forEach(w=>rows.push(['Hinweis',w]));
  for (let i=0;i<rows.length;i+=10000) put_(sh,i+1,rows.slice(i,i+10000));
}

function beispiel20261103() {
  const r=vorhersageUTC('2026-11-03');
  writePrediction_(r);
  console.log(JSON.stringify(r,null,2));
  return r;
}

function beispielWasserstand20261014() {
  const r=wasserstandUTC('2026-10-14 0927Z');
  schreibeWasserstand_(r);
  return r;
}

function beispielGanglinie20261014() {
  const r=wasserstandZeitraumUTC('2026-10-14 0000Z','2026-10-14 2359Z',1);
  schreibeWasserstand_(r);
  console.log(r.werte.length+' Modellwerte geschrieben.');
  return r;
}

// -------------------- Tests ohne Pegeldatei --------------------

function testStundenrasterUTC() {
  const t=sourceUTC_('1965/06/09 05:00','Test');
  check_(t===Date.UTC(1965,5,9,5),'UTC-Parsing 1965 fehlerhaft.');
  check_(sourceUTC_('2021/03/28 02:00','Test')===Date.UTC(2021,2,28,2),
    'UTC darf keine Frühjahrslücke haben.');
  check_(sourceUTC_('2021/10/31 02:00','Test')===Date.UTC(2021,9,31,2),
    'UTC darf keine doppelte Herbststunde haben.');
  function mustFail(fn,msg) {
    let rejected=false;
    try { fn(); } catch (_) { rejected=true; }
    check_(rejected,msg);
  }
  mustFail(()=>sourceUTC_('1965/02/29 05:00','Test'),'Ungültiges Datum akzeptiert.');
  const src={start:t,end:t+6*HOUR,first:null,last:null,gaps:0,stamps:0};
  acceptStamp_(src,t,'Test');
  acceptStamp_(src,t+3*HOUR,'Test');
  check_(src.gaps===2 && src.stamps===2,'05:00 → 08:00 muss zwei Fehlstunden ergeben.');
  mustFail(()=>acceptStamp_(src,t+3*HOUR,'Test'),'Duplikat akzeptiert.');
  mustFail(()=>acceptStamp_(src,t+3.5*HOUR,'Test'),'Rasterverletzung akzeptiert.');
  mustFail(()=>acceptStamp_(src,src.end,'Test'),'Exklusives Ende akzeptiert.');
  check_(interpolateHours_([2,4],0.5)===3,'Interpolation benachbarter Stunden.');
  check_(interpolateHours_([2,NaN],0)===2,'Gültiger exakter Messwert verloren.');
  check_(Number.isNaN(interpolateHours_([2,NaN,4],0.5)),'Messlücke überbrückt.');
  const y=[0,3,4,3,0];
  const p=peaks_(y,0,0,y.length,t);
  check_(p.length===1 && p[0][0]===t+2*HOUR && p[0][1]==='HW' && p[0][2]===4,
    'HW-Erkennung auf dem Stundenraster.');
  check_(peaks_([0,NaN,4,3,0],0,0,5,t).length===0,'Scheitel an Datenlücke akzeptiert.');
  console.log('UTC-, Kalender-, Stundenraster-, Lücken- und Scheiteltests erfolgreich.');
  return true;
}

// Alter Funktionsname für bestehende manuelle Aufrufe.
function testZeitumstellung() { return testStundenrasterUTC(); }

function testAstronomie() {
  requireAstronomy_();
  const cache=new Map();
  const r=[
    [2*14468,'1991-01-01T00:18:00Z'],
    [2*14468+1,'1991-01-01T12:50:00Z'],
    [2*21172,'2009-12-30T23:12:00Z']
  ].map(([q,reference])=>{
    const t=trueTransit_(q,cache);
    return {q,berechnet:iso_(t),tabellenwert:reference,
      differenzMinuten:(t-Date.parse(reference))/MINUTE};
  });
  console.log(JSON.stringify(r,null,2));
  return r;
}
