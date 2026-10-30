/*
 * hddu.gs – Version 3
 *
 * Zeitstempelbasierte HDdU-Analyse:
 *   Spalte A: gesetzliche deutsche Ortszeit (MEZ/MESZ)
 *   Spalte B: Wasserstand
 *
 * Astronomy Engine bleibt als separate Bibliotheksdatei vorhanden.
 *
 * Ablauf:
 *   INDEX -> EXTRACT -> ESTIMATE -> ASSIGN -> FIT
 *         -> CURVE_INIT -> CURVE_SAMPLE -> CURVE_FIT -> DONE
 *
 * Start:                 hdduStart()
 * Status:                hdduStatus()
 * Fortsetzen:            hdduFortsetzen()
 * Stop:                  hdduStop()
 * Zeitumstellungstest:   testZeitumstellung()
 * Astronomietest:        testAstronomie()
 *
 * Vorhersage:
 *   beispiel20261103()
 *   beispielWasserstand20261014()
 *   beispielGanglinie20261014()
 *
 * Voraussetzungen:
 * - Quellen gehören zum selben Pegel und Höhenbezug.
 * - Zeilen stehen in tatsächlicher chronologischer Reihenfolge.
 * - Spalte A zeigt die ursprüngliche deutsche Ortszeit.
 * - Zeitstempel liegen auf ganzen Minuten.
 * - Quellen während einer Analyse nicht verändern.
 *
 * Fehlende Messminuten werden NICHT interpoliert.
 * Für die Ganglinienabtastung wird nur zwischen zwei unmittelbar
 * benachbarten, gültigen UTC-Minutenwerten interpoliert.
 *
 * Die MEZ/MESZ-Umrechnung implementiert die seit 1996 geltenden
 * EU-Regeln. Für die angegebenen Quellen 2007–2025 ist dies passend.
 * Andere historische Zeitregeln sind nicht implementiert.
 *
 * Keine amtliche Gezeitenvorausberechnung.
 * Keine Vorhersage von Windstau oder aktuellen Abflussverhältnissen.
 */

// ============================================================
// Konfiguration
// ============================================================

const HD = {
  FIRST_ROW: 2,
  TIME_COLUMN: 1,
  LEVEL_COLUMN: 2,

  FIRST_UTC: Date.parse('2006-12-31T23:00:00Z'),

  T0: Date.UTC(1949, 11, 31, 21, 8, 0),
  SYNC_MINUTES: 24.23,
  MOON_DAY_H: 2 * 12.4206012,

  // Physische Quellenzeilen je Indexblock.
  INDEX_ROWS: 20000,

  // Reserve, um einen Block nicht mitten in einer Herbststunde
  // ohne nachfolgenden eindeutigen Zeitstempel enden zu lassen.
  INDEX_LOOKAHEAD: 300,

  // UTC-Minuten je Extraktionsschritt.
  READ_BLOCK: 60000,
  ASSIGN_BLOCK: 350,

  SMOOTH_HALF: 5,
  EXTREME_HALF: 120,
  MAX_PLATEAU_MIN: 60,

  HW_LAG_BRANCH_H: 17 + 20 / 60,
  MAX_ASSIGN_ERROR_H: 2.5,

  INVALID_LEVELS: [],

  STATE_KEY: 'HDDU_STATE_V3',
  RESULT_KEY: 'HDDU_RESULT_ID_V3'
};

const HD_SOURCES = [
  {
    label: '2007–2010',
    id: '1iBTYT7bfBDJ1QYvXRYJgCO7NkHdrBtkWR1ZR5BGCbTc',
    gid: 1168579514,
    firstUTC: '2006-12-31T23:00:00Z',
    endUTC: '2010-12-31T23:00:00Z'
  },
  {
    label: '2011–2015',
    id: '1mAvle1MzFbDApBcG8ZQT64l1qBO1DW67Lly847eN4Dw',
    gid: 1885735774,
    firstUTC: '2010-12-31T23:00:00Z',
    endUTC: '2015-12-31T23:00:00Z'
  },
  {
    label: '2016–2020',
    id: '1VH6sqmJacLw9A2tLYylohcMOiIxF5pjPGAtMT00F0ds',
    gid: 1383979387,
    firstUTC: '2015-12-31T23:00:00Z',
    endUTC: '2020-12-31T23:00:00Z'
  },
  {
    label: '2021–2025',
    id: '1koxg-b7FQ_pQ-INhmaA83KKTEdckCBHb4qma4AjPzN0',
    gid: 1866576966,
    firstUTC: '2020-12-31T23:00:00Z',
    endUTC: '2025-12-31T23:00:00Z'
  }
];

const HD_CURVE = {
  POINTS: 96,
  SAMPLE_DAYS: 20,
  MAX_OUTPUT_ROWS: 100000
};

const HOUR = 3600000;
const MINUTE = 60000;
const DAY = 86400000;
const RAD = Math.PI / 180;

const HD_TERMS = [
  ['ZZZZAZ',   0.0548098,  6],
  ['ZZZBZZ',   0.2306165, 13],
  ['ZZAZZZ',   1.0201944,  7],
  ['ZZBXZZ',   1.8097724, 31],
  ['ZZBZZZ',   2.0403886, 17],
  ['ZAXZZZ',  11.5978420, 14],
  ['ZAXAZZ',  11.7131503,  8],
  ['ZAYXZZ',  12.3874200, 34],
  ['ZAYZZZ',  12.6180365, 19],
  ['ZAYAAZ',  12.7881545, 39],
  ['ZAZYZZ',  13.5229227,  3],
  ['ZAZZZZ',  13.6382309,  4],
  ['ZAZZAZ',  13.6930407, 38],
  ['ZAZAZZ',  13.7535391, 21],
  ['ZABBAZ',  15.9640460, 36],
  ['ZBWZZZ',  24.2158785, 11],
  ['ZBXZYZ',  25.1812631, 35],
  ['ZBXZZZ',  25.2360729,  1],
  ['ZBYZZZ',  26.2562673, 12],
  ['ZBZXZZ',  27.0458453, 33],
  ['ZBZYZZ',  27.1611535, 15],
  ['ZBZZZZ',  27.2764618,  2],
  ['ZBZZAZ',  27.3312716, 27],
  ['ZCVAZZ',  36.9492232, 10],
  ['ZCXYZZ',  38.7589956, 16],
  ['ZCXZZZ',  38.8743038, 24],
  ['ZCXAZZ',  38.9896120, 22],
  ['ZCZYZZ',  40.7993844, 23],
  ['ZDUZZZ',  49.4519514, 29],
  ['ZDVZZZ',  50.4721458,  5],
  ['ZDXZZZ',  52.5125347,  9],
  ['ZDXZAZ',  52.5673444, 37],
  ['ZDZZZZ',  54.5529235, 30],
  ['ZETAZZ',  62.1852961, 25],
  ['ZEVYZZ',  63.9950685, 28],
  ['ZEVAZZ',  64.2256849, 26],
  ['ZFTZZZ',  75.7082187, 20],
  ['ZFVZZZ',  77.7486076, 18],
  ['ZHRZZZ', 100.9442917, 32]
];

// Nur innerhalb eines einzelnen Scriptaufrufs verwendet.
let HD_INDEX_CACHE = null;
let HD_BLOCK_CACHE = new Map();
let HD_SOURCE_SHEET_CACHE = new Map();
const HD_DST_CACHE = {};

// ============================================================
// Steuerung
// ============================================================

function hdduStart(vonUTC, bisUTC) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    requireAstronomy_();

    const old = loadState_();
    if (old && old.stage !== 'DONE') {
      throw new Error(
        'Eine V3-Analyse existiert bereits. ' +
        'Fortsetzen oder mit hdduStop() verwerfen.'
      );
    }

    if (HD_TERMS.length !== 39) {
      throw new Error('39 Konstituenten erwartet.');
    }

    if (
      !Number.isInteger(HD_CURVE.POINTS) ||
      HD_CURVE.POINTS < 96 ||
      HD_CURVE.POINTS > 288
    ) {
      throw new Error('POINTS muss zwischen 96 und 288 liegen.');
    }

    if (
      !Number.isInteger(HD_CURVE.SAMPLE_DAYS) ||
      HD_CURVE.SAMPLE_DAYS < 1
    ) {
      throw new Error('SAMPLE_DAYS muss positiv und ganzzahlig sein.');
    }

    const start = parseMinuteUTC_(
      vonUTC === undefined ? HD_SOURCES[0].firstUTC : vonUTC
    );
    const end = parseMinuteUTC_(
      bisUTC === undefined
        ? HD_SOURCES[HD_SOURCES.length - 1].endUTC
        : bisUTC
    );

    const availableStart = Date.parse(HD_SOURCES[0].firstUTC);
    const availableEnd =
      Date.parse(HD_SOURCES[HD_SOURCES.length - 1].endUTC);

    if (
      start < availableStart ||
      end > availableEnd ||
      end <= start ||
      end - start < 10000 * MINUTE
    ) {
      throw new Error('Ungültiger oder zu kurzer Analysezeitraum.');
    }

    removeTriggers_();
    resetRunCaches_();

    const sources = buildSourceManifest_();

    const out = SpreadsheetApp.create(
      'HDdU V3 Zeitstempel ' +
      Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm')
    );
    out.setSpreadsheetTimeZone('Etc/UTC');

    const info = out.getSheets()[0];
    info.setName('Info');
    info.getRange(1, 1, 10, 2).setValues([
      ['Eigenschaft', 'Wert'],
      ['Verfahren', 'HDdU V3 mit Zeitstempeln aus Spalte A'],
      ['Analysebeginn UTC', iso_(start)],
      ['Analyseende UTC exklusiv', iso_(end)],
      ['Zeitbasis der Quellen', 'Angezeigte gesetzliche Ortszeit Europe/Berlin'],
      ['Status', 'INDEX'],
      ['Konstituentenkandidaten', HD_TERMS.length],
      ['Ganglinienpunkte', HD_CURVE.POINTS],
      ['Höhenbezug', 'Originaleinheit und Originaldatum der Quellen'],
      ['Lückenbehandlung', 'Fehlende UTC-Minuten bleiben fehlend']
    ]);
    info.setFrozenRows(1);

    const sourceInfo = createSheet_(out, 'Quellen', [
      'Quelle', 'Spreadsheet_ID', 'GID', 'Nominal_Start_UTC',
      'Nominal_Ende_UTC_exklusiv', 'Soll_Minuten',
      'Physische_Zeilen', 'Tabellen_Zeitzone',
      'Zeitstempel', 'Gueltige_Wasserstaende',
      'Zeilen_ohne_Zeit_und_Wert',
      'Fehlende_Minuten_intern',
      'Fehlende_Minuten_Anfang',
      'Fehlende_Minuten_Ende',
      'Fehlende_Zeitpositionen_gesamt',
      'Erster_Zeitstempel_UTC', 'Letzter_Zeitstempel_UTC'
    ]);

    appendRows_(sourceInfo, sources.map(s => [
      s.label, s.id, s.gid, s.firstUTC, s.endUTC,
      s.capacity, s.actual, s.sheetTimeZone,
      '', '', '', '', '', '', '', '', ''
    ]));

    createSheet_(out, 'Zeitindex', [
      'Quelle_Index', 'Startzeile', 'Zeilenzahl',
      'Erste_UTC_ms', 'Letzte_UTC_ms',
      'Vorherige_UTC_ms', 'Zeitstempelzahl',
      'Fehlende_Minuten_intern'
    ]);

    createSheet_(out, 'Extrema', [
      'UTC_ms', 'Art', 'Wasserstand'
    ]);

    createSheet_(out, 'Zuordnung', [
      'Halbtransit_q', 'Transitnummer_n', 'k',
      'Intervall_zum_mittleren_oberen_Transit_h',
      'Wasserstand', 'Ereignis_UTC_ms',
      'Wahrer_Transit_UTC_ms', 'Zuordnungsfehler_h'
    ]);

    createSheet_(out, 'Modell', ['k', 'JSON']);

    createSheet_(out, 'Koeffizienten', [
      'k', 'Groesse', 'Doodson', 'Grad_pro_Transit',
      'Cos_Koeff', 'Sin_Koeff', 'Amplitude', 'Phase_Grad'
    ]);

    createSheet_(out, 'Diagnostik', [
      'k', 'Zugeordnet', 'Verwendet', 'Glieder',
      'Anpassungs_RMSE_Zeit_min',
      'Anpassungs_RMSE_Hoehe_Originaleinheit',
      'Test_N', 'Test_RMSE_Zeit_min',
      'Test_RMSE_Hoehe_Originaleinheit', 'Test_Glieder'
    ]);

    const state = {
      version: 3,
      stage: 'INDEX',
      outputId: out.getId(),
      begin: (start - HD.FIRST_UTC) / MINUTE,
      count: (end - HD.FIRST_UTC) / MINUTE,
      next: (start - HD.FIRST_UTC) / MINUTE,
      analysisStart: start,
      analysisEnd: end,
      sources: sources,
      indexSource: 0,
      indexRow: HD.FIRST_ROW,
      curvePoints: HD_CURVE.POINTS,
      createdUTC: iso_(Date.now()),
      signature: configSignature_()
    };

    rememberAppendRows_(state, out);
    saveState_(state);

    PropertiesService.getScriptProperties()
      .setProperty(HD.RESULT_KEY, out.getId());

    createTrigger_();
    console.log('Ergebnisdatei: ' + out.getUrl());
    return out.getUrl();

  } finally {
    lock.releaseLock();
  }
}

function hdduWeiter() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    const state = loadState_();

    if (!state || state.stage === 'DONE') {
      removeTriggers_();
      return;
    }

    if (state.version !== 3) {
      throw new Error('Unpassender Arbeitszustand.');
    }

    if (state.signature !== configSignature_()) {
      throw new Error(
        'Konfiguration wurde während der Analyse verändert. ' +
        'Ursprüngliche Konfiguration wiederherstellen oder neu starten.'
      );
    }

    resetRunCaches_();

    const out = SpreadsheetApp.openById(state.outputId);
    restoreAppendRows_(state, out);

    switch (state.stage) {
      case 'INDEX':
        indexNextBlock_(state, out);
        break;
      case 'EXTRACT':
        extractBlock_(state, out);
        break;
      case 'ESTIMATE':
        estimateLags_(state, out);
        break;
      case 'ASSIGN':
        assignBlock_(state, out);
        break;
      case 'FIT':
        fitNextClass_(state, out);
        break;
      case 'CURVE_INIT':
        curveInitialize_(state, out);
        break;
      case 'CURVE_SAMPLE':
        curveSampleBlock_(state, out);
        break;
      case 'CURVE_FIT':
        curveFitStep_(state, out);
        break;
      default:
        throw new Error('Unbekannte Stufe: ' + state.stage);
    }

    delete state.lastError;

    SpreadsheetApp.flush();
    rememberAppendRows_(state, out);
    saveState_(state);
    out.getSheetByName('Info').getRange('B6').setValue(state.stage);

    if (state.stage === 'DONE') {
      removeTriggers_();
      console.log('Analyse fertig: ' + out.getUrl());
    }

  } catch (error) {
    removeTriggers_();

    const committed = loadState_();
    if (committed) {
      committed.lastError = String(error);
      saveState_(committed);
    }

    console.error(error);
    throw error;

  } finally {
    lock.releaseLock();
  }
}

function hdduFortsetzen() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const state = loadState_();
    if (!state || state.stage === 'DONE') {
      throw new Error('Keine unvollständige V3-Analyse vorhanden.');
    }

    if (state.signature !== configSignature_()) {
      throw new Error('Konfiguration passt nicht zum Arbeitszustand.');
    }

    delete state.lastError;
    saveState_(state);
    removeTriggers_();
    createTrigger_();

    console.log('Fortsetzung aktiviert: ' + state.stage);
  } finally {
    lock.releaseLock();
  }
}

function hdduStatus() {
  const state = loadState_();
  console.log(JSON.stringify(state, null, 2));
  if (state) {
    console.log(
      'https://docs.google.com/spreadsheets/d/' + state.outputId
    );
  }
  return state;
}

function hdduStop() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    removeTriggers_();
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty(HD.STATE_KEY);
    props.deleteProperty('HDDU_STATE_V2');
    console.log('Gestoppt. Ergebnisdateien bleiben erhalten.');
  } finally {
    lock.releaseLock();
  }
}

function createTrigger_() {
  ScriptApp.newTrigger('hdduWeiter')
    .timeBased().everyMinutes(1).create();
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'hdduWeiter') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function loadState_() {
  const text = PropertiesService.getScriptProperties()
    .getProperty(HD.STATE_KEY);
  return text ? JSON.parse(text) : null;
}

function saveState_(state) {
  PropertiesService.getScriptProperties()
    .setProperty(HD.STATE_KEY, JSON.stringify(state));
}

function configSignature_() {
  return JSON.stringify({
    algorithm: 'timestamp-v3-berlin-sequence-1',
    firstRow: HD.FIRST_ROW,
    timeColumn: HD.TIME_COLUMN,
    levelColumn: HD.LEVEL_COLUMN,
    firstUTC: HD.FIRST_UTC,
    t0: HD.T0,
    sync: HD.SYNC_MINUTES,
    moonDay: HD.MOON_DAY_H,
    smooth: HD.SMOOTH_HALF,
    extreme: HD.EXTREME_HALF,
    plateau: HD.MAX_PLATEAU_MIN,
    branch: HD.HW_LAG_BRANCH_H,
    assign: HD.MAX_ASSIGN_ERROR_H,
    invalid: HD.INVALID_LEVELS,
    points: HD_CURVE.POINTS,
    sources: HD_SOURCES,
    terms: HD_TERMS
  });
}

function resetRunCaches_() {
  HD_INDEX_CACHE = null;
  HD_BLOCK_CACHE = new Map();
  HD_SOURCE_SHEET_CACHE = new Map();
}

function rememberAppendRows_(state, out) {
  state.committedRows = {};
  [
    'Info', 'Zeitindex', 'Extrema', 'Zuordnung',
    'Koeffizienten', 'Diagnostik'
  ].forEach(name => {
    const sheet = out.getSheetByName(name);
    if (sheet) state.committedRows[name] = sheet.getLastRow();
  });
}

function restoreAppendRows_(state, out) {
  if (!state.committedRows) return;

  Object.keys(state.committedRows).forEach(name => {
    const sheet = out.getSheetByName(name);
    if (!sheet) return;

    const committed = state.committedRows[name];
    const actual = sheet.getLastRow();

    if (actual > committed) {
      sheet.getRange(
        committed + 1, 1, actual - committed, sheet.getMaxColumns()
      ).clearContent();
    }
  });
}

// ============================================================
// Tabellen und Quellenmanifest
// ============================================================

function ensureSheetSize_(sheet, rows, columns) {
  if (rows > sheet.getMaxRows()) {
    sheet.insertRowsAfter(
      sheet.getMaxRows(), rows - sheet.getMaxRows()
    );
  }
  if (columns > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(), columns - sheet.getMaxColumns()
    );
  }
}

function createSheet_(ss, name, headers) {
  const sheet = ss.insertSheet(name);
  ensureSheetSize_(sheet, 2, headers.length);

  if (sheet.getMaxColumns() > headers.length) {
    sheet.deleteColumns(
      headers.length + 1, sheet.getMaxColumns() - headers.length
    );
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}

function appendRows_(sheet, rows) {
  if (!rows.length) return;
  const first = sheet.getLastRow() + 1;
  ensureSheetSize_(sheet, first + rows.length - 1, rows[0].length);
  sheet.getRange(first, 1, rows.length, rows[0].length).setValues(rows);
}

function sourceSheet_(source) {
  const key = source.id + ':' + source.gid;
  if (HD_SOURCE_SHEET_CACHE.has(key)) {
    return HD_SOURCE_SHEET_CACHE.get(key);
  }

  const ss = SpreadsheetApp.openById(source.id);
  const sheet = ss.getSheets().find(s => s.getSheetId() === source.gid);

  if (!sheet) {
    throw new Error('Quellblatt fehlt: ' + source.label);
  }

  HD_SOURCE_SHEET_CACHE.set(key, sheet);
  return sheet;
}

function buildSourceManifest_() {
  let previousEnd = null;

  return HD_SOURCES.map(source => {
    const start = Date.parse(source.firstUTC);
    const end = Date.parse(source.endUTC);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      (previousEnd !== null && start !== previousEnd)
    ) {
      throw new Error('Ungültige nominale Quellenintervalle.');
    }

    previousEnd = end;

    const sheet = sourceSheet_(source);
    const lastRow = sheet.getLastRow();
    const capacity = (end - start) / MINUTE;

    return Object.assign({}, source, {
      startMs: start,
      endMs: end,
      capacity: capacity,
      lastRow: lastRow,
      actual: Math.max(0, lastRow - HD.FIRST_ROW + 1),
      sheetTimeZone: sheet.getParent().getSpreadsheetTimeZone(),
      indexed: false,
      stampCount: 0,
      validLevelCount: 0,
      emptyRows: 0,
      missingInternal: 0,
      firstObservedUTC: null,
      lastObservedUTC: null
    });
  });
}

function numericLevel_(value) {
  if (value === '' || value === null) return NaN;

  let x;

  if (typeof value === 'number') {
    x = value;
  } else if (typeof value === 'string') {
    const text = value.trim().replace(',', '.');
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
      return NaN;
    }
    x = Number(text);
  } else {
    return NaN;
  }

  if (!Number.isFinite(x) || HD.INVALID_LEVELS.includes(x)) {
    return NaN;
  }
  return x;
}

function hasCellContent_(value) {
  return value !== null &&
    value !== '' &&
    !(typeof value === 'string' && value.trim() === '');
}

// ============================================================
// MEZ/MESZ -> mögliche UTC-Zeitpunkte
// ============================================================

function lastSunday_(year, monthZeroBased) {
  const last = new Date(Date.UTC(year, monthZeroBased + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
}

function berlinTransitions_(year) {
  if (!HD_DST_CACHE[year]) {
    HD_DST_CACHE[year] = {
      // Hier als lokale Wandzeit auf einer rechnerischen UTC-Achse.
      spring02: Date.UTC(year, 2, lastSunday_(year, 2), 2),
      spring03: Date.UTC(year, 2, lastSunday_(year, 2), 3),
      autumn02: Date.UTC(year, 9, lastSunday_(year, 9), 2),
      autumn03: Date.UTC(year, 9, lastSunday_(year, 9), 3)
    };
  }
  return HD_DST_CACHE[year];
}

/*
 * Liefert:
 *   []             für leere Zelle
 *   [UTC]          für eindeutige Ortszeit
 *   [UTC1, UTC2]   für doppelte Herbststunde ohne Zusatz
 *
 * Unterstützt:
 *   01.01.2021 00:00:00
 *   1.1.2021 0:00
 *   2021-01-01 00:00:00
 *   2021-01-01T00:00:00
 *
 * Optionaler Zusatz: MEZ oder MESZ.
 */
function localUTCCandidates_(value, location) {
  const text = String(value === null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .trim();

  if (!text) return [];

  let year, month, day, hour, minute, second, zone;
  let m = text.match(
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(MEZ|MESZ))?$/i
  );

  if (m) {
    day = Number(m[1]);
    month = Number(m[2]);
    year = Number(m[3]);
    hour = Number(m[4]);
    minute = Number(m[5]);
    second = m[6] === undefined ? 0 : Number(m[6]);
    zone = m[7] ? m[7].toUpperCase() : '';
  } else {
    m = text.match(
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(MEZ|MESZ))?$/i
    );

    if (!m) {
      throw new Error(
        location + ': Zeitformat nicht unterstützt: "' + text +
        '". Erwartet wird z. B. 31.10.2021 02:30:00.'
      );
    }

    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
    hour = Number(m[4]);
    minute = Number(m[5]);
    second = m[6] === undefined ? 0 : Number(m[6]);
    zone = m[7] ? m[7].toUpperCase() : '';
  }

  if (year < 1996 || year > 2099) {
    throw new Error(
      location + ': Unterstützter MEZ/MESZ-Regelbereich: 1996–2099.'
    );
  }

  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    throw new Error(location + ': Ungültiger Zeitstempel: ' + text);
  }

  if (second !== 0) {
    throw new Error(
      location + ': Sekunden ungleich null. Minutenraster erforderlich.'
    );
  }

  const t = berlinTransitions_(year);
  let offsets;

  if (wall >= t.spring02 && wall < t.spring03) {
    throw new Error(
      location + ': Diese deutsche Ortszeit existiert beim ' +
      'Frühjahrswechsel nicht: ' + text
    );
  } else if (wall >= t.autumn02 && wall < t.autumn03) {
    // Erst MESZ, danach MEZ.
    offsets = [2, 1];
  } else if (wall >= t.spring03 && wall < t.autumn02) {
    offsets = [2];
  } else {
    offsets = [1];
  }

  if (zone) {
    const requested = zone === 'MESZ' ? 2 : 1;
    offsets = offsets.filter(x => x === requested);

    if (!offsets.length) {
      throw new Error(
        location + ': Zusatz ' + zone +
        ' widerspricht den deutschen Sommerzeitregeln: ' + text
      );
    }
  }

  return offsets.map(offset => wall - offset * HOUR);
}

/*
 * Löst einen zusammenhängenden Abschnitt mehrdeutiger Zeiten.
 *
 * Vorwärts-/Rückwärtsprüfung sämtlicher Kandidatenpfade:
 * Jeder gewählte UTC-Zeitpunkt muss strikt nach seinem Vorgänger
 * und vor seinem Nachfolger liegen.
 *
 * Nur eine eindeutige Lösung wird akzeptiert.
 * Lücken werden nicht durch Annahmen über "wahrscheinlich
 * aufeinanderfolgende Minuten" geschlossen.
 */
function resolveAutumnRun_(run, previousUTC, nextUTC) {
  const n = run.length;
  if (!n) return [];

  const forward = [];
  const backward = [];

  for (let i = 0; i < n; i++) {
    forward[i] = run[i].candidates.map(value => {
      if (i === 0) return value > previousUTC;

      return run[i - 1].candidates.some(
        (before, j) => forward[i - 1][j] && before < value
      );
    });
  }

  for (let i = n - 1; i >= 0; i--) {
    backward[i] = run[i].candidates.map(value => {
      if (i === n - 1) return value < nextUTC;

      return run[i + 1].candidates.some(
        (after, j) => backward[i + 1][j] && value < after
      );
    });
  }

  return run.map((entry, i) => {
    const possible = entry.candidates.filter(
      (_, j) => forward[i][j] && backward[i][j]
    );

    if (!possible.length) {
      throw new Error(
        entry.location +
        ': Keine chronologisch konsistente UTC-Zuordnung. ' +
        'Sortierung oder doppelte Zeitstempel prüfen.'
      );
    }

    if (possible.length !== 1) {
      throw new Error(
        entry.location +
        ': Herbststunde wegen Datenlücke nicht eindeutig. ' +
        'Mögliche UTC-Zeiten: ' +
        possible.map(iso_).join(' / ') +
        '. Originalquelle prüfen und, falls bekannt, ' +
        'MEZ oder MESZ ausdrücklich am Zeitstempel ergänzen.'
      );
    }

    return possible[0];
  });
}

/*
 * Konvertiert einen physischen Quellenblock.
 *
 * previousUTC ist der letzte tatsächliche Zeitstempel vor
 * diesem Block, NICHT eine aus Zeilennummern berechnete Zeit.
 */
function convertSourceBlock_(
  source, firstRow, texts, levels, previousUTC
) {
  const length = texts.length;
  const times = new Float64Array(length);
  times.fill(NaN);

  let previous = previousUTC === null
    ? source.startMs - MINUTE
    : previousUTC;

  let run = [];

  function flushRun(nextUTC) {
    if (!run.length) return;

    const resolved = resolveAutumnRun_(run, previous, nextUTC);

    for (let j = 0; j < run.length; j++) {
      times[run[j].index] = resolved[j];
    }

    previous = resolved[resolved.length - 1];
    run = [];
  }

  for (let i = 0; i < length; i++) {
    const location = source.label + ', A' + (firstRow + i);
    let candidates = localUTCCandidates_(texts[i][0], location);

    if (!candidates.length) {
      if (hasCellContent_(levels[i][0])) {
        throw new Error(
          location + ': Wasserstand vorhanden, aber Zeitstempel fehlt.'
        );
      }
      continue;
    }

    candidates = candidates.filter(
      time => time >= source.startMs && time < source.endMs
    );

    if (!candidates.length) {
      throw new Error(
        location + ': Zeitstempel liegt außerhalb des nominalen ' +
        'Quellenintervalls ' + source.firstUTC + ' bis ' + source.endUTC
      );
    }

    if (candidates.length > 1) {
      run.push({
        index: i,
        candidates: candidates,
        location: location
      });
    } else {
      const time = candidates[0];
      flushRun(time);

      if (time <= previous) {
        throw new Error(
          location + ': Nicht streng chronologisch bzw. doppelter ' +
          'UTC-Zeitstempel: ' + iso_(time) +
          ', vorher: ' + iso_(previous)
        );
      }

      times[i] = time;
      previous = time;
    }
  }

  // Normalerweise enden Indexblöcke mit einer eindeutigen Zeit.
  // Am Quellenende dient nur die nominale exklusive Grenze
  // als obere Schranke; Mehrdeutigkeit wird weiterhin abgelehnt.
  flushRun(source.endMs);

  let first = null;
  let last = null;
  let stampCount = 0;
  let validLevelCount = 0;
  let emptyRows = 0;
  let missingInternal = 0;
  let predecessor = previousUTC;

  for (let i = 0; i < length; i++) {
    const time = times[i];

    if (!Number.isFinite(time)) {
      emptyRows++;
      continue;
    }

    if (first === null) first = time;
    last = time;
    stampCount++;

    if (Number.isFinite(numericLevel_(levels[i][0]))) {
      validLevelCount++;
    }

    if (predecessor !== null) {
      const difference = (time - predecessor) / MINUTE;
      if (!Number.isInteger(difference) || difference <= 0) {
        throw new Error('Interner Fehler beim UTC-Minutenraster.');
      }
      missingInternal += difference - 1;
    }

    predecessor = time;
  }

  return {
    times: times,
    first: first,
    last: last,
    stampCount: stampCount,
    validLevelCount: validLevelCount,
    emptyRows: emptyRows,
    missingInternal: missingInternal
  };
}

// ============================================================
// Zeitindex erstellen
// ============================================================

function indexNextBlock_(state, out) {
  if (state.indexSource >= state.sources.length) {
    state.stage = 'EXTRACT';
    return;
  }

  const source = state.sources[state.indexSource];

  if (state.indexRow > source.lastRow) {
    finishSourceIndex_(state, out);
    return;
  }

  const sheet = sourceSheet_(source);
  const firstRow = state.indexRow;
  const remaining = source.lastRow - firstRow + 1;
  const base = Math.min(HD.INDEX_ROWS, remaining);
  const readCount = Math.min(
    remaining, base + HD.INDEX_LOOKAHEAD
  );

  const texts = sheet.getRange(
    firstRow, HD.TIME_COLUMN, readCount, 1
  ).getDisplayValues();

  const levels = sheet.getRange(
    firstRow, HD.LEVEL_COLUMN, readCount, 1
  ).getValues();

  let used = base;
  let lastCandidates = [];

  // Prüfen, ob der eigentliche Block in einer mehrdeutigen
  // Herbststunde endet. Leere Zeilen verändern den Zustand nicht.
  for (let i = base - 1; i >= 0; i--) {
    lastCandidates = localUTCCandidates_(
      texts[i][0], source.label + ', A' + (firstRow + i)
    );
    if (lastCandidates.length) break;
  }

  if (lastCandidates.length > 1) {
    let foundAnchor = false;

    for (let i = base; i < readCount; i++) {
      const candidates = localUTCCandidates_(
        texts[i][0], source.label + ', A' + (firstRow + i)
      );
      used = i + 1;

      if (candidates.length === 1) {
        foundAnchor = true;
        break;
      }
    }

    if (!foundAnchor && readCount < remaining) {
      throw new Error(
        source.label + ', ab Zeile ' + firstRow +
        ': Herbststunde reicht über die Lookahead-Reserve hinaus. ' +
        'INDEX_LOOKAHEAD erhöhen und fortsetzen.'
      );
    }
  }

  const previousUTC = source.lastObservedUTC;

  const converted = convertSourceBlock_(
    source,
    firstRow,
    texts.slice(0, used),
    levels.slice(0, used),
    previousUTC
  );

  appendRows_(out.getSheetByName('Zeitindex'), [[
    state.indexSource,
    firstRow,
    used,
    converted.first === null ? '' : converted.first,
    converted.last === null ? '' : converted.last,
    previousUTC === null ? '' : previousUTC,
    converted.stampCount,
    converted.missingInternal
  ]]);

  source.stampCount += converted.stampCount;
  source.validLevelCount += converted.validLevelCount;
  source.emptyRows += converted.emptyRows;
  source.missingInternal += converted.missingInternal;

  if (
    source.firstObservedUTC === null &&
    converted.first !== null
  ) {
    source.firstObservedUTC = converted.first;
  }

  if (converted.last !== null) {
    source.lastObservedUTC = converted.last;
  }

  state.indexRow += used;

  if (state.indexRow > source.lastRow) {
    finishSourceIndex_(state, out);
  }
}

function finishSourceIndex_(state, out) {
  const source = state.sources[state.indexSource];

  if (!source.stampCount) {
    source.missingStart = source.capacity;
    source.missingEnd = 0;
  } else {
    source.missingStart =
      (source.firstObservedUTC - source.startMs) / MINUTE;

    source.missingEnd =
      (source.endMs - MINUTE - source.lastObservedUTC) / MINUTE;
  }

  source.missingTotal =
    source.missingStart +
    source.missingInternal +
    source.missingEnd;

  if (source.missingTotal !== source.capacity - source.stampCount) {
    throw new Error('Inkonsistente Lückenbilanz: ' + source.label);
  }

  source.indexed = true;

  out.getSheetByName('Quellen')
    .getRange(state.indexSource + 2, 9, 1, 9)
    .setValues([[
      source.stampCount,
      source.validLevelCount,
      source.emptyRows,
      source.missingInternal,
      source.missingStart,
      source.missingEnd,
      source.missingTotal,
      source.firstObservedUTC === null ? '' : iso_(source.firstObservedUTC),
      source.lastObservedUTC === null ? '' : iso_(source.lastObservedUTC)
    ]]);

  state.indexSource++;
  state.indexRow = HD.FIRST_ROW;

  if (state.indexSource >= state.sources.length) {
    state.stage = 'EXTRACT';

    appendRows_(out.getSheetByName('Info'), [
      ['Zeitindex fertig UTC', iso_(Date.now())],
      [
        'Fehlende Zeitpositionen in allen Quellen',
        state.sources.reduce((sum, s) => sum + s.missingTotal, 0)
      ],
      [
        'Hinweis Zeitindex',
        'Lücken umfassen fehlende Zeitstempel. ' +
        'Ungültige Wasserstände bei vorhandenem Zeitstempel ' +
        'sind zusätzlich in der Belegung berücksichtigt.'
      ]
    ]);
  }
}

// ============================================================
// Zeitstempelbasierter Minutenleser
// ============================================================

function loadTimeIndex_(state) {
  if (HD_INDEX_CACHE) return HD_INDEX_CACHE;

  const sheet = SpreadsheetApp.openById(state.outputId)
    .getSheetByName('Zeitindex');

  const count = sheet.getLastRow() - 1;
  if (count < 1) throw new Error('Zeitindex fehlt.');

  HD_INDEX_CACHE = sheet.getRange(2, 1, count, 8)
    .getValues()
    .filter(row => Number(row[6]) > 0)
    .map(row => ({
      sourceIndex: Number(row[0]),
      firstRow: Number(row[1]),
      rowCount: Number(row[2]),
      firstUTC: Number(row[3]),
      lastUTC: Number(row[4]),
      previousUTC: row[5] === '' ? null : Number(row[5]),
      stampCount: Number(row[6])
    }));

  return HD_INDEX_CACHE;
}

function readIndexedBlock_(state, entry) {
  const key = entry.sourceIndex + ':' + entry.firstRow;

  if (HD_BLOCK_CACHE.has(key)) {
    return HD_BLOCK_CACHE.get(key);
  }

  const source = state.sources[entry.sourceIndex];
  const sheet = sourceSheet_(source);

  const texts = sheet.getRange(
    entry.firstRow, HD.TIME_COLUMN, entry.rowCount, 1
  ).getDisplayValues();

  const rawLevels = sheet.getRange(
    entry.firstRow, HD.LEVEL_COLUMN, entry.rowCount, 1
  ).getValues();

  const converted = convertSourceBlock_(
    source, entry.firstRow, texts, rawLevels, entry.previousUTC
  );

  if (
    converted.first !== entry.firstUTC ||
    converted.last !== entry.lastUTC ||
    converted.stampCount !== entry.stampCount
  ) {
    throw new Error(
      'Quelle wurde seit der Indexierung verändert: ' +
      source.label + ', ab Zeile ' + entry.firstRow
    );
  }

  const values = new Float64Array(entry.rowCount);
  for (let i = 0; i < values.length; i++) {
    values[i] = numericLevel_(rawLevels[i][0]);
  }

  const result = {
    times: converted.times,
    values: values
  };

  // Begrenzter Cache innerhalb eines Triggeraufrufs.
  if (HD_BLOCK_CACHE.size >= 8) {
    HD_BLOCK_CACHE.delete(HD_BLOCK_CACHE.keys().next().value);
  }
  HD_BLOCK_CACHE.set(key, result);

  return result;
}

/*
 * Liefert [first,last) als echtes UTC-Minutenraster.
 * first/last beziehen sich auf HD.FIRST_UTC.
 */
function readMinuteRange_(state, first, last) {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    last < first
  ) {
    throw new Error('Ungültiger Minutenbereich.');
  }

  const result = new Float64Array(last - first);
  result.fill(NaN);

  if (last === first) return result;

  const fromUTC = HD.FIRST_UTC + first * MINUTE;
  const toUTC = HD.FIRST_UTC + last * MINUTE;

  for (const entry of loadTimeIndex_(state)) {
    if (entry.lastUTC < fromUTC || entry.firstUTC >= toUTC) {
      continue;
    }

    const block = readIndexedBlock_(state, entry);

    for (let i = 0; i < block.times.length; i++) {
      const time = block.times[i];

      if (
        !Number.isFinite(time) ||
        time < fromUTC ||
        time >= toUTC
      ) {
        continue;
      }

      const position = (time - fromUTC) / MINUTE;

      if (!Number.isInteger(position)) {
        throw new Error('Zeitstempel liegt nicht im UTC-Minutenraster.');
      }

      result[position] = block.values[i];
    }
  }

  return result;
}

// ============================================================
// Scheitelpunkterkennung
// ============================================================

function extractBlock_(state, out) {
  const coreStart = state.next;
  const coreEnd = Math.min(state.count, coreStart + HD.READ_BLOCK);

  const margin =
    HD.EXTREME_HALF + HD.SMOOTH_HALF + HD.MAX_PLATEAU_MIN + 10;

  const readStart = Math.max(state.begin, coreStart - margin);
  const readEnd = Math.min(state.count, coreEnd + margin);

  const values = readMinuteRange_(state, readStart, readEnd);
  const smooth = smoothComplete_(values, HD.SMOOTH_HALF);
  const maxima = rollingExtreme_(smooth, HD.EXTREME_HALF, true);
  const minima = rollingExtreme_(smooth, HD.EXTREME_HALF, false);

  const rows = collectPeaks_(
    smooth, maxima, true, readStart, coreStart, coreEnd
  ).concat(collectPeaks_(
    smooth, minima, false, readStart, coreStart, coreEnd
  ));

  rows.sort((a, b) => a[0] - b[0]);
  appendRows_(out.getSheetByName('Extrema'), rows);

  state.next = coreEnd;
  if (coreEnd >= state.count) state.stage = 'ESTIMATE';
}

function smoothComplete_(a, half) {
  const n = a.length;
  const sum = new Float64Array(n + 1);
  const count = new Int32Array(n + 1);

  for (let i = 0; i < n; i++) {
    const valid = Number.isFinite(a[i]);
    sum[i + 1] = sum[i] + (valid ? a[i] : 0);
    count[i + 1] = count[i] + (valid ? 1 : 0);
  }

  const result = new Float64Array(n);
  result.fill(NaN);
  const width = 2 * half + 1;

  for (let i = half; i < n - half; i++) {
    const left = i - half;
    const right = i + half + 1;

    if (count[right] - count[left] === width) {
      result[i] = (sum[right] - sum[left]) / width;
    }
  }

  return result;
}

function rollingExtreme_(a, half, maximum) {
  const n = a.length;
  const width = 2 * half + 1;
  const result = new Float64Array(n);
  result.fill(NaN);

  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let validCount = 0;

  for (let right = 0; right < n; right++) {
    const leaving = right - width;

    if (leaving >= 0 && Number.isFinite(a[leaving])) validCount--;

    while (head < tail && queue[head] <= leaving) head++;

    if (Number.isFinite(a[right])) {
      validCount++;

      while (head < tail) {
        const previous = a[queue[tail - 1]];
        const remove = maximum
          ? previous <= a[right]
          : previous >= a[right];
        if (!remove) break;
        tail--;
      }

      queue[tail++] = right;
    }

    if (right >= width - 1 && validCount === width) {
      result[right - half] = a[queue[head]];
    }
  }

  return result;
}

function collectPeaks_(
  a, extreme, maximum, readStart, coreStart, coreEnd
) {
  const rows = [];
  const w = HD.EXTREME_HALF;

  for (let i = w; i < a.length - w; i++) {
    if (!Number.isFinite(extreme[i]) || a[i] !== extreme[i]) continue;

    const start = i;

    while (
      i + 1 < a.length - w &&
      Number.isFinite(extreme[i + 1]) &&
      a[i + 1] === extreme[i + 1]
    ) {
      i++;
    }

    const end = i;
    if (end - start + 1 > HD.MAX_PLATEAU_MIN) continue;

    const centre = Math.floor((start + end) / 2);
    const globalIndex = readStart + centre;

    if (globalIndex < coreStart || globalIndex >= coreEnd) continue;

    const goodFlanks = maximum
      ? a[centre] > a[centre - w] && a[centre] > a[centre + w]
      : a[centre] < a[centre - w] && a[centre] < a[centre + w];

    if (!goodFlanks) continue;

    let offset = (start + end) / 2 - centre;
    let level = a[centre];

    if (start === end) {
      const d = 5;
      const left = a[centre - d];
      const right = a[centre + d];
      const curvature = left - 2 * level + right;

      if (
        Number.isFinite(curvature) &&
        curvature !== 0 &&
        (maximum ? curvature < 0 : curvature > 0)
      ) {
        const candidate = d * (left - right) / (2 * curvature);
        if (Math.abs(candidate) <= d) {
          offset = candidate;
          level -= (right - left) * (right - left) / (8 * curvature);
        }
      }
    }

    rows.push([
      HD.FIRST_UTC + (globalIndex + offset) * MINUTE,
      maximum ? 'HW' : 'NW',
      level
    ]);
  }

  return rows;
}

// ============================================================
// Mondtransite
// ============================================================

function meanUpper_(n) {
  return HD.T0 + HD.SYNC_MINUTES * MINUTE +
    n * HD.MOON_DAY_H * HOUR;
}

function meanHalf_(q) {
  return meanUpper_(0) + q * HD.MOON_DAY_H * HOUR / 2;
}

function requireAstronomy_() {
  const names = [
    'AstroTime', 'GeoMoon', 'Rotation_EQJ_EQD',
    'RotateVector', 'EquatorFromVector', 'SiderealTime'
  ];

  if (typeof Astronomy === 'undefined') {
    throw new Error('Astronomy Engine fehlt.');
  }

  names.forEach(name => {
    if (typeof Astronomy[name] !== 'function') {
      throw new Error('Astronomy-Funktion fehlt: ' + name);
    }
  });
}

function wrap180_(x) {
  return ((x + 180) % 360 + 360) % 360 - 180;
}

function moonHourAngle_(ms) {
  const time = new Astronomy.AstroTime(new Date(ms));
  const eqj = Astronomy.GeoMoon(time);
  const eqd = Astronomy.RotateVector(
    Astronomy.Rotation_EQJ_EQD(time), eqj
  );
  const equatorial = Astronomy.EquatorFromVector(eqd);

  return wrap180_(
    15 * (Astronomy.SiderealTime(time) - equatorial.ra)
  );
}

function trueTransit_(q, cache) {
  const key = String(q);
  if (cache && Object.prototype.hasOwnProperty.call(cache, key)) {
    return cache[key];
  }

  const lower = ((q % 2) + 2) % 2;
  const target = lower ? 180 : 0;
  let time = meanHalf_(q);

  for (let iteration = 0; iteration < 10; iteration++) {
    const error = wrap180_(moonHourAngle_(time) - target);
    const delta = 5 * MINUTE;

    const speed = wrap180_(
      moonHourAngle_(time + delta) - moonHourAngle_(time - delta)
    ) / (2 * delta / HOUR);

    if (!(speed > 10 && speed < 20)) {
      throw new Error('Unplausible Mond-Stundenwinkelgeschwindigkeit.');
    }

    const correction = error / speed * HOUR;
    time -= correction;
    if (Math.abs(correction) < 100) break;
  }

  if (
    Math.abs(wrap180_(moonHourAngle_(time) - target)) > 0.001 ||
    Math.abs(time - meanHalf_(q)) > 4 * HOUR
  ) {
    throw new Error('Mondtransit nicht sicher bestimmt, q=' + q);
  }

  if (cache) cache[key] = time;
  return time;
}

// ============================================================
// Intervallschätzung und Ereigniszuordnung
// ============================================================

function circularLag_(rows, branchCentre) {
  const halfH = HD.MOON_DAY_H / 2;
  let cosine = 0;
  let sine = 0;

  for (const row of rows) {
    const hours = (Number(row[0]) - meanUpper_(0)) / HOUR;
    const angle = 2 * Math.PI * hours / halfH;
    cosine += Math.cos(angle);
    sine += Math.sin(angle);
  }

  let lag = Math.atan2(sine, cosine) * halfH / (2 * Math.PI);
  lag += Math.round((branchCentre - lag) / halfH) * halfH;

  return {
    lag: lag,
    coherence: Math.hypot(cosine, sine) / Math.max(1, rows.length)
  };
}

function estimateLags_(state, out) {
  const sheet = out.getSheetByName('Extrema');
  const count = sheet.getLastRow() - 1;
  if (count < 200) throw new Error('Zu wenige erkannte Scheitelpunkte.');

  const rows = sheet.getRange(2, 1, count, 3).getValues();
  const highs = rows.filter(r => r[1] === 'HW');
  const lows = rows.filter(r => r[1] === 'NW');

  const hw = circularLag_(highs, HD.HW_LAG_BRANCH_H);
  const nw = circularLag_(lows, hw.lag + HD.MOON_DAY_H / 4);

  console.log(JSON.stringify({
    anzahlHW: highs.length,
    anzahlNW: lows.length,
    HW: hw,
    NW: nw
  }));

  if (hw.coherence < 0.5 || nw.coherence < 0.5) {
    throw new Error(
      'Keine ausreichend eindeutige halbtägige Scheitelpunktfolge. ' +
      'Kohärenz HW=' + hw.coherence +
      ', NW=' + nw.coherence +
      '. Zeitindex, Fehlwerte und Scheitelpunkterkennung prüfen.'
    );
  }

  const ebb = nw.lag - hw.lag;
  if (!(ebb > 2 && ebb < 11)) {
    throw new Error('Unplausibler Abstand HW -> NW: ' + ebb + ' h.');
  }

  state.hwLag = hw.lag;
  state.nwLag = nw.lag;
  state.extremaCount = count;
  state.nextEvent = 0;
  state.stage = 'ASSIGN';

  appendRows_(out.getSheetByName('Info'), [
    ['Geschätztes HW-Intervall h', hw.lag],
    ['Geschätztes NW-Intervall h', nw.lag],
    ['HW Phasenkohärenz', hw.coherence],
    ['NW Phasenkohärenz', nw.coherence]
  ]);
}

function hdduDiagnoseIntervalle() {
  const state = loadState_();
  if (!state) throw new Error('Kein V3-Arbeitszustand.');

  const sheet = SpreadsheetApp.openById(state.outputId)
    .getSheetByName('Extrema');

  const count = sheet.getLastRow() - 1;
  if (count < 1) throw new Error('Keine Extrema vorhanden.');

  const rows = sheet.getRange(2, 1, count, 3).getValues();
  const highs = rows.filter(r => r[1] === 'HW');
  const lows = rows.filter(r => r[1] === 'NW');

  const hw = circularLag_(highs, HD.HW_LAG_BRANCH_H);
  const nw = circularLag_(lows, hw.lag + HD.MOON_DAY_H / 4);

  const result = {
    anzahlHW: highs.length,
    anzahlNW: lows.length,
    HW: hw,
    NW: nw,
    abstandHWzuNW_h: nw.lag - hw.lag
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

function assignBlock_(state, out) {
  const size = Math.min(
    HD.ASSIGN_BLOCK, state.extremaCount - state.nextEvent
  );

  const rows = out.getSheetByName('Extrema')
    .getRange(2 + state.nextEvent, 1, size, 3).getValues();

  const cache = {};
  const assigned = [];
  const halfMs = HD.MOON_DAY_H * HOUR / 2;

  for (const row of rows) {
    const time = Number(row[0]);
    const high = row[1] === 'HW';
    const lag = high ? state.hwLag : state.nwLag;

    const initialQ = Math.round(
      (time - meanUpper_(0) - lag * HOUR) / halfMs
    );

    let best = null;

    for (let q = initialQ - 1; q <= initialQ + 1; q++) {
      const transit = trueTransit_(q, cache);
      const error = Math.abs((time - transit) / HOUR - lag);

      if (!best || error < best.error) {
        best = { q: q, transit: transit, error: error };
      }
    }

    if (best.error > HD.MAX_ASSIGN_ERROR_H) continue;

    const n = Math.floor(best.q / 2);
    const lower = best.q - 2 * n;
    const k = 1 + 2 * lower + (high ? 0 : 1);

    assigned.push([
      best.q, n, k,
      (time - meanUpper_(n)) / HOUR,
      Number(row[2]), time, best.transit, best.error
    ]);
  }

  appendRows_(out.getSheetByName('Zuordnung'), assigned);
  state.nextEvent += size;

  if (state.nextEvent >= state.extremaCount) {
    state.stage = 'FIT';
    state.nextK = 1;
  }
}

// ============================================================
// Statistik und Ausgleichung
// ============================================================

function transitBounds_(rows) {
  let min = Infinity;
  let max = -Infinity;
  rows.forEach(r => {
    min = Math.min(min, r.n);
    max = Math.max(max, r.n);
  });
  return { min: min, max: max };
}

function selectTerms_(rows) {
  const bounds = transitBounds_(rows);
  const span = bounds.max - bounds.min;
  if (!(span > 60)) throw new Error('Zu kurze Transitspanne.');

  const resolution = 360 / span;
  const selected = [];

  for (const term of HD_TERMS.slice().sort((a, b) => a[2] - b[2])) {
    if (term[1] < resolution) continue;

    if (selected.every(other =>
      Math.abs(term[1] - other[1]) >= resolution
    )) {
      selected.push(term);
    }
  }

  return selected.sort((a, b) => a[1] - b[1]);
}

function designRow_(n, terms) {
  const row = [1];

  for (const term of terms) {
    const angle = ((term[1] * n) % 360) * RAD;
    row.push(Math.cos(angle), Math.sin(angle));
  }

  return row;
}

function evaluate_(n, terms, coefficients) {
  let result = coefficients[0];

  for (let j = 0; j < terms.length; j++) {
    const angle = ((terms[j][1] * n) % 360) * RAD;
    result += coefficients[1 + 2 * j] * Math.cos(angle);
    result += coefficients[2 + 2 * j] * Math.sin(angle);
  }

  return result;
}

function stats_(a) {
  if (!a.length) return { mean: NaN, sd: NaN };

  const mean = a.reduce((sum, x) => sum + x, 0) / a.length;
  const variance = a.reduce(
    (sum, x) => sum + (x - mean) * (x - mean), 0
  ) / Math.max(1, a.length - 1);

  return { mean: mean, sd: Math.sqrt(variance) };
}

function inside3_(x, stat) {
  return Math.abs(x - stat.mean) <= Math.max(3 * stat.sd, 1e-10);
}

function rmse_(errors) {
  return Math.sqrt(
    errors.reduce((sum, x) => sum + x * x, 0) /
    Math.max(1, errors.length)
  );
}

function checkSampleSize_(rows, terms) {
  const parameters = 1 + 2 * terms.length;
  if (rows.length < Math.max(100, 3 * parameters)) {
    throw new Error(
      'Zu wenige Beobachtungen für ' + terms.length + ' Konstituenten.'
    );
  }
}

function fitPair_(rows, terms) {
  const a = rows.map(r => designRow_(r.n, terms));
  const b = rows.map(r => [r.interval, r.height]);
  const coefficients = qrLeastSquares_(a, b);

  return {
    time: coefficients.map(r => r[0]),
    height: coefficients.map(r => r[1])
  };
}

function robustFit_(rows) {
  const ts = stats_(rows.map(r => r.interval));
  const hs = stats_(rows.map(r => r.height));

  let used = rows.filter(r =>
    inside3_(r.interval, ts) && inside3_(r.height, hs)
  );

  let terms = selectTerms_(used);
  checkSampleSize_(used, terms);
  const first = fitPair_(used, terms);

  const te = used.map(r =>
    r.interval - evaluate_(r.n, terms, first.time)
  );
  const he = used.map(r =>
    r.height - evaluate_(r.n, terms, first.height)
  );

  const tr = stats_(te);
  const hr = stats_(he);

  used = used.filter((r, i) =>
    inside3_(te[i], tr) && inside3_(he[i], hr)
  );

  terms = selectTerms_(used);
  checkSampleSize_(used, terms);
  const fit = fitPair_(used, terms);
  const bounds = transitBounds_(used);

  return {
    terms: terms,
    time: fit.time,
    height: fit.height,
    usedCount: used.length,
    nMin: bounds.min,
    nMax: bounds.max,
    trainingTimeRMSEmin: 60 * rmse_(used.map(r =>
      r.interval - evaluate_(r.n, terms, fit.time)
    )),
    trainingHeightRMSE: rmse_(used.map(r =>
      r.height - evaluate_(r.n, terms, fit.height)
    ))
  };
}

/*
 * Householder-QR; keine Normalgleichungen.
 */
function qrLeastSquares_(inputA, inputB) {
  if (!inputA.length || inputA.length !== inputB.length) {
    throw new Error('Ungültige Ausgleichungsdimensionen.');
  }

  const a = inputA.map(row => Float64Array.from(row));
  const b = inputB.map(row => Float64Array.from(row));

  const m = a.length;
  const p = a[0].length;
  const rhs = b[0].length;

  if (m < p) throw new Error('Unterbestimmtes Ausgleichungssystem.');

  const tolerance = 1e-9 * Math.sqrt(m);

  for (let k = 0; k < p; k++) {
    let norm2 = 0;
    for (let i = k; i < m; i++) norm2 += a[i][k] * a[i][k];

    const norm = Math.sqrt(norm2);
    if (!Number.isFinite(norm) || norm < tolerance) {
      throw new Error(
        'Numerisch nicht trennbare Modellspalten. ' +
        'Datenabdeckung und Konstituentenauswahl prüfen.'
      );
    }

    const alpha = a[k][k] >= 0 ? -norm : norm;
    const v = new Float64Array(m - k);
    v[0] = a[k][k] - alpha;

    for (let i = k + 1; i < m; i++) v[i - k] = a[i][k];

    let vv = 0;
    for (let i = 0; i < v.length; i++) vv += v[i] * v[i];
    const beta = 2 / vv;

    for (let j = k; j < p; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i - k] * a[i][j];
      dot *= beta;
      for (let i = k; i < m; i++) a[i][j] -= dot * v[i - k];
    }

    for (let j = 0; j < rhs; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i - k] * b[i][j];
      dot *= beta;
      for (let i = k; i < m; i++) b[i][j] -= dot * v[i - k];
    }

    a[k][k] = alpha;
    for (let i = k + 1; i < m; i++) a[i][k] = 0;
  }

  const x = Array.from({ length: p }, () => new Array(rhs).fill(0));

  for (let j = 0; j < rhs; j++) {
    for (let i = p - 1; i >= 0; i--) {
      let value = b[i][j];
      for (let k = i + 1; k < p; k++) value -= a[i][k] * x[k][j];
      x[i][j] = value / a[i][i];
    }
  }

  return x;
}

// ============================================================
// Scheitelpunktmodelle
// ============================================================

function fitNextClass_(state, out) {
  const sheet = out.getSheetByName('Zuordnung');
  const count = sheet.getLastRow() - 1;

  if (count < 400) throw new Error('Zu wenige zugeordnete Scheitelpunkte.');

  const all = sheet.getRange(2, 1, count, 8).getValues();
  const unique = new Map();

  for (const row of all) {
    const key = row[1] + ':' + row[2];
    const event = {
      n: Number(row[1]),
      k: Number(row[2]),
      interval: Number(row[3]),
      height: Number(row[4]),
      time: Number(row[5]),
      score: Number(row[7])
    };

    if (!unique.has(key) || event.score < unique.get(key).score) {
      unique.set(key, event);
    }
  }

  const invalid = new Set();

  for (const [key, event] of unique) {
    if (event.k !== 1 && event.k !== 3) continue;

    const lowKey = event.n + ':' + (event.k + 1);
    const low = unique.get(lowKey);

    if (low) {
      const duration = (low.time - event.time) / HOUR;
      if (!(duration > 2 && duration < 11)) {
        invalid.add(key);
        invalid.add(lowKey);
      }
    }
  }

  const k = state.nextK;
  const rows = Array.from(unique.entries())
    .filter(([key, event]) => event.k === k && !invalid.has(key))
    .map(([, event]) => event)
    .sort((a, b) => a.n - b.n);

  if (rows.length < 200) {
    throw new Error('Zu wenige Daten für Ereignisklasse k=' + k);
  }

  const cutoff = rows[0].n +
    0.8 * (rows[rows.length - 1].n - rows[0].n);

  const train = rows.filter(r => r.n <= cutoff);
  const test = rows.filter(r => r.n > cutoff);

  let validation = {
    n: 0, timeRMSEmin: null, heightRMSE: null, terms: null
  };

  if (train.length >= 200 && test.length >= 40) {
    const tm = robustFit_(train);

    validation = {
      n: test.length,
      timeRMSEmin: 60 * rmse_(test.map(r =>
        r.interval - evaluate_(r.n, tm.terms, tm.time)
      )),
      heightRMSE: rmse_(test.map(r =>
        r.height - evaluate_(r.n, tm.terms, tm.height)
      )),
      terms: tm.terms.length
    };
  }

  const fit = robustFit_(rows);

  const model = {
    version: 3,
    basis: 'MEAN_UPPER_TRANSIT_2013',
    k: k,
    t0: HD.T0,
    syncMinutes: HD.SYNC_MINUTES,
    moonDayHours: HD.MOON_DAY_H,
    terms: fit.terms,
    time: fit.time,
    height: fit.height,
    nMin: fit.nMin,
    nMax: fit.nMax,
    usedCount: fit.usedCount,
    inputStartUTC: iso_(rows[0].time),
    inputEndUTC: iso_(rows[rows.length - 1].time),
    trainingTimeRMSEmin: fit.trainingTimeRMSEmin,
    trainingHeightRMSE: fit.trainingHeightRMSE,
    validation: validation
  };

  out.getSheetByName('Modell').getRange(k + 1, 1, 1, 2)
    .setValues([[k, JSON.stringify(model)]]);

  appendRows_(
    out.getSheetByName('Koeffizienten'), coefficientRows_(model)
  );

  appendRows_(out.getSheetByName('Diagnostik'), [[
    k, rows.length, fit.usedCount, fit.terms.length,
    fit.trainingTimeRMSEmin, fit.trainingHeightRMSE,
    validation.n,
    validation.timeRMSEmin === null ? '' : validation.timeRMSEmin,
    validation.heightRMSE === null ? '' : validation.heightRMSE,
    validation.terms === null ? '' : validation.terms
  ]]);

  state.nextK++;

  if (state.nextK > 4) {
    state.stage = 'CURVE_INIT';
    appendRows_(out.getSheetByName('Info'), [
      ['Scheitelpunktmodelle fertig UTC', iso_(Date.now())]
    ]);
  }
}

function coefficientRows_(model) {
  const rows = [];

  for (const [name, coefficients] of [
    ['Zeit_h', model.time],
    ['Hoehe_Originaleinheit', model.height]
  ]) {
    rows.push([model.k, name, 'MITTEL', 0, coefficients[0], 0, '', '']);

    model.terms.forEach((term, j) => {
      const a = coefficients[1 + 2 * j];
      const b = coefficients[2 + 2 * j];

      rows.push([
        model.k, name, term[0], term[1], a, b,
        Math.hypot(a, b),
        (Math.atan2(b, a) / RAD + 360) % 360
      ]);
    });
  }

  return rows;
}

// ============================================================
// Ganglinienanalyse
// ============================================================

function curveInitialize_(state, out) {
  const points = state.curvePoints;
  const moonDayMs = HD.MOON_DAY_H * HOUR;
  const stepMs = moonDayMs / points;
  const originMs = meanUpper_(0) + state.hwLag * HOUR + stepMs / 2;

  const nFirst = Math.floor(
    (state.analysisStart - originMs) / moonDayMs
  );
  const nLast = Math.floor(
    (state.analysisEnd - 1 - originMs) / moonDayMs
  );

  let samples = out.getSheetByName('Ganglinie_Daten');
  if (!samples) {
    const headers = ['Transitnummer_n'];
    for (let k = 1; k <= points; k++) {
      headers.push('Wasserstand_k' + k);
    }
    samples = createSheet_(out, 'Ganglinie_Daten', headers);
  }

  ensureSheetSize_(samples, nLast - nFirst + 2, points + 1);

  if (!out.getSheetByName('Ganglinie_Modell')) {
    createSheet_(out, 'Ganglinie_Modell', ['k', 'JSON']);
  }
  ensureSheetSize_(out.getSheetByName('Ganglinie_Modell'), points + 1, 2);

  if (!out.getSheetByName('Ganglinie_Diagnostik')) {
    createSheet_(out, 'Ganglinie_Diagnostik', [
      'k', 'Vorhanden', 'Verwendet', 'Glieder',
      'Anpassungs_RMSE_Originaleinheit', 'Test_N',
      'Test_RMSE_Originaleinheit', 'Test_Bias_Originaleinheit',
      'Test_Glieder', 'Belegung_Anteil'
    ]);
  }
  ensureSheetSize_(
    out.getSheetByName('Ganglinie_Diagnostik'), points + 1, 10
  );

  if (!out.getSheetByName('Ganglinie_Meta')) {
    createSheet_(out, 'Ganglinie_Meta', ['Eigenschaft', 'JSON']);
  }

  state.curve = {
    version: 3,
    complete: false,
    points: points,
    moonDayMs: moonDayMs,
    stepMs: stepMs,
    originMs: originMs,
    hwLagHours: state.hwLag,
    t0: HD.T0,
    syncMinutes: HD.SYNC_MINUTES,
    moonDayHours: HD.MOON_DAY_H,
    nFirst: nFirst,
    nLast: nLast,
    analysisStartUTC: iso_(state.analysisStart),
    analysisEndUTCExclusive: iso_(state.analysisEnd),
    interpolation: 'linear',
    unit: 'Originaleinheit der Quellspalte B',
    sourceTimeHandling: 'Europe/Berlin, chronologisch aufgelöst'
  };

  writeCurveMeta_(out, state.curve);
  state.curveNextN = nFirst;
  state.stage = 'CURVE_SAMPLE';
}

function writeCurveMeta_(out, meta) {
  out.getSheetByName('Ganglinie_Meta').getRange(2, 1, 1, 2)
    .setValues([['Metadaten', JSON.stringify(meta)]]);
}

function curveSampleTime_(meta, n, k) {
  return meta.originMs + n * meta.moonDayMs + (k - 1) * meta.stepMs;
}

function curveSampleBlock_(state, out) {
  const meta = state.curve;
  const firstN = state.curveNextN;
  const lastN = Math.min(
    meta.nLast, firstN + HD_CURVE.SAMPLE_DAYS - 1
  );

  const firstTime = curveSampleTime_(meta, firstN, 1);
  const lastTime = curveSampleTime_(meta, lastN, meta.points);

  const readStart = Math.max(
    state.begin, Math.floor((firstTime - HD.FIRST_UTC) / MINUTE)
  );

  const readEnd = Math.min(
    state.count, Math.ceil((lastTime - HD.FIRST_UTC) / MINUTE) + 1
  );

  const values = readMinuteRange_(state, readStart, readEnd);
  const rows = [];

  for (let n = firstN; n <= lastN; n++) {
    const row = [n];

    for (let k = 1; k <= meta.points; k++) {
      const time = curveSampleTime_(meta, n, k);

      if (time < state.analysisStart || time >= state.analysisEnd) {
        row.push('');
        continue;
      }

      const position = (time - HD.FIRST_UTC) / MINUTE;
      const left = Math.floor(position);
      const fraction = position - left;
      let height = NaN;

      if (left >= readStart && left < readEnd) {
        const a = values[left - readStart];

        if (fraction === 0) {
          height = a;
        } else if (left + 1 < readEnd) {
          const b = values[left + 1 - readStart];
          if (Number.isFinite(a) && Number.isFinite(b)) {
            height = a + fraction * (b - a);
          }
        }
      }

      row.push(Number.isFinite(height) ? height : '');
    }

    rows.push(row);
  }

  out.getSheetByName('Ganglinie_Daten')
    .getRange(
      2 + firstN - meta.nFirst, 1, rows.length, meta.points + 1
    ).setValues(rows);

  state.curveNextN = lastN + 1;

  if (state.curveNextN > meta.nLast) {
    state.curveK = 1;
    state.curveFitStage = 'TRAIN_FIRST';
    state.stage = 'CURVE_FIT';
  }
}

function curveReadPhase_(state, out) {
  const meta = state.curve;
  const count = meta.nLast - meta.nFirst + 1;

  const values = out.getSheetByName('Ganglinie_Daten')
    .getRange(2, state.curveK + 1, count, 1).getValues();

  const rows = [];

  for (let i = 0; i < values.length; i++) {
    const value = values[i][0];
    if (typeof value === 'number' && Number.isFinite(value)) {
      rows.push({ n: meta.nFirst + i, height: value });
    }
  }

  return rows;
}

function curveInitialFilter_(rows) {
  const stat = stats_(rows.map(r => r.height));
  return rows.filter(r => inside3_(r.height, stat));
}

function curveFitHeight_(rows, terms) {
  checkSampleSize_(rows, terms);

  return qrLeastSquares_(
    rows.map(r => designRow_(r.n, terms)),
    rows.map(r => [r.height])
  ).map(r => r[0]);
}

function curveFirstFit_(rows) {
  const used = curveInitialFilter_(rows);
  const terms = selectTerms_(used);
  return { terms: terms, height: curveFitHeight_(used, terms) };
}

function curveSecondFit_(rows, first) {
  let used = curveInitialFilter_(rows);

  const errors = used.map(r =>
    r.height - evaluate_(r.n, first.terms, first.height)
  );

  const stat = stats_(errors);
  used = used.filter((r, i) => inside3_(errors[i], stat));

  const terms = selectTerms_(used);
  const height = curveFitHeight_(used, terms);
  const bounds = transitBounds_(used);

  return {
    terms: terms,
    height: height,
    usedCount: used.length,
    nMin: bounds.min,
    nMax: bounds.max,
    trainingHeightRMSE: rmse_(used.map(r =>
      r.height - evaluate_(r.n, terms, height)
    ))
  };
}

function curveFitStep_(state, out) {
  const rows = curveReadPhase_(state, out);
  const meta = state.curve;

  if (rows.length < 200) {
    throw new Error('Zu wenige Gangliniendaten für k=' + state.curveK);
  }

  const cutoff = meta.nFirst + 0.8 * (meta.nLast - meta.nFirst);
  const train = rows.filter(r => r.n <= cutoff);
  const test = rows.filter(r => r.n > cutoff);

  switch (state.curveFitStage) {
    case 'TRAIN_FIRST':
      state.curveValidation = {
        n: 0, rmse: null, bias: null, terms: null
      };

      if (train.length >= 200 && test.length >= 40) {
        state.curvePreliminary = curveFirstFit_(train);
        state.curveFitStage = 'TRAIN_SECOND';
      } else {
        state.curveFitStage = 'FINAL_FIRST';
      }
      return;

    case 'TRAIN_SECOND': {
      const fit = curveSecondFit_(train, state.curvePreliminary);
      const errors = test.map(r =>
        r.height - evaluate_(r.n, fit.terms, fit.height)
      );

      state.curveValidation = {
        n: test.length,
        rmse: rmse_(errors),
        bias: stats_(errors).mean,
        terms: fit.terms.length
      };

      delete state.curvePreliminary;
      state.curveFitStage = 'FINAL_FIRST';
      return;
    }

    case 'FINAL_FIRST':
      state.curvePreliminary = curveFirstFit_(rows);
      state.curveFitStage = 'FINAL_SECOND';
      return;

    case 'FINAL_SECOND': {
      const fit = curveSecondFit_(rows, state.curvePreliminary);
      const validation = state.curveValidation;

      const model = {
        version: 3,
        kind: 'HDDU_HYDROGRAPH',
        k: state.curveK,
        terms: fit.terms,
        height: fit.height,
        nMin: fit.nMin,
        nMax: fit.nMax,
        availableCount: rows.length,
        usedCount: fit.usedCount,
        trainingHeightRMSE: fit.trainingHeightRMSE,
        validation: validation
      };

      out.getSheetByName('Ganglinie_Modell')
        .getRange(state.curveK + 1, 1, 1, 2)
        .setValues([[state.curveK, JSON.stringify(model)]]);

      out.getSheetByName('Ganglinie_Diagnostik')
        .getRange(state.curveK + 1, 1, 1, 10)
        .setValues([[
          state.curveK, rows.length, fit.usedCount, fit.terms.length,
          fit.trainingHeightRMSE, validation.n,
          validation.rmse === null ? '' : validation.rmse,
          validation.bias === null ? '' : validation.bias,
          validation.terms === null ? '' : validation.terms,
          rows.length / (meta.nLast - meta.nFirst + 1)
        ]]);

      delete state.curvePreliminary;
      delete state.curveValidation;

      state.curveK++;
      state.curveFitStage = 'TRAIN_FIRST';

      if (state.curveK > meta.points) {
        state.curve.complete = true;
        state.curve.finishedUTC = iso_(Date.now());
        writeCurveMeta_(out, state.curve);

        appendRows_(out.getSheetByName('Info'), [
          ['Gesamte Analyse fertig UTC', iso_(Date.now())],
          [
            'Interpolation',
            'Linear zwischen synthetisierten Ganglinien-Stützstellen.'
          ],
          [
            'Validierung',
            'Diagnostik und Ganglinie_Diagnostik prüfen. ' +
            'Testdaten sind zeitlich später als Trainingsdaten.'
          ],
          [
            'Methodischer Hinweis',
            '39-Glieder-Satz anhand HW/NW veröffentlicht; ' +
            'Ganglinienanwendung kombiniert ihn mit BSH 50/2013.'
          ],
          [
            'Gültigkeit',
            'Astronomische Gezeiten, kein Windstau und ' +
            'keine aktuelle Abflusskorrektur.'
          ]
        ]);

        state.stage = 'DONE';
      }
      return;
    }

    default:
      throw new Error('Unbekannter Ganglinien-Fit-Schritt.');
  }
}

// ============================================================
// Scheitelpunktvorhersage
// ============================================================

function resultId_(id) {
  const result = id || PropertiesService.getScriptProperties()
    .getProperty(HD.RESULT_KEY);

  if (!result) throw new Error('Keine V3-Ergebnisdatei vorhanden.');
  return result;
}

function vorhersageUTC(datum, ergebnisDateiId) {
  requireAstronomy_();

  const start = parseUTCDate_(datum);
  const end = start + DAY;
  const id = resultId_(ergebnisDateiId);
  const out = SpreadsheetApp.openById(id);
  const sheet = out.getSheetByName('Modell');

  if (!sheet) throw new Error('Keine Scheitelpunktmodelle vorhanden.');

  const saved = sheet.getRange(2, 2, 4, 1).getValues();
  if (saved.some(row => !row[0])) {
    throw new Error('Scheitelpunktanalyse noch nicht vollständig.');
  }

  const models = saved.map(row => JSON.parse(row[0]));

  models.forEach((model, index) => {
    if (
      model.version !== 3 ||
      model.k !== index + 1 ||
      model.basis !== 'MEAN_UPPER_TRANSIT_2013' ||
      model.t0 !== HD.T0 ||
      model.syncMinutes !== HD.SYNC_MINUTES ||
      model.moonDayHours !== HD.MOON_DAY_H
    ) {
      throw new Error('Modell oder Zeitbasis unpassend.');
    }
  });

  const cache = {};
  const events = [];
  const warnings = [];
  const moonDayMs = HD.MOON_DAY_H * HOUR;

  const nStart = Math.floor(
    (start - meanUpper_(0)) / moonDayMs
  ) - 4;

  const nEnd = Math.ceil(
    (end - meanUpper_(0)) / moonDayMs
  ) + 2;

  for (let n = nStart; n <= nEnd; n++) {
    for (const model of models) {
      const interval = evaluate_(n, model.terms, model.time);

      if (!Number.isFinite(interval) || Math.abs(interval) > 72) {
        throw new Error('Unplausible extrapolierte Ereigniszeit.');
      }

      const time = meanUpper_(n) + interval * HOUR;
      if (time < start || time >= end) continue;

      const lower = model.k >= 3;
      const q = 2 * n + (lower ? 1 : 0);

      events.push({
        art: model.k % 2 ? 'HW' : 'NW',
        utc: iso_(time),
        wasserstand: evaluate_(n, model.terms, model.height),
        transitnummer: n,
        k: model.k,
        zugeordneterTransit: lower ? 'unterer' : 'oberer',
        transitUTC: iso_(trueTransit_(q, cache)),
        verwendeteKonstituenten: model.terms.length
      });
    }
  }

  events.sort((a, b) => a.utc.localeCompare(b.utc));

  for (let i = 1; i < events.length; i++) {
    if (events[i].art === events[i - 1].art) {
      warnings.push('Nicht alternierende HW/NW-Folge: Modell prüfen.');
    }
  }

  const shortestYears = Math.min(...models.map(model =>
    (model.nMax - model.nMin) * HD.MOON_DAY_H / (24 * 365.2425)
  ));

  if (shortestYears < 9) {
    warnings.push(
      'Weniger als neun Jahre: wichtige nahe Frequenzen nicht ' +
      'getrennt bestimmbar; Referenzpegelanalyse fachlich vorzuziehen.'
    );
  } else if (shortestYears < 18.6133) {
    warnings.push(
      'Mindestens eine Ereignisreihe umfasst weniger als ' +
      'eine Mondknotenperiode.'
    );
  }

  if (models.some(model => model.terms.length < 39)) {
    warnings.push('Nicht überall konnten alle 39 Glieder verwendet werden.');
  }

  const latest = Math.min(...models.map(model =>
    Date.parse(model.inputEndUTC)
  ));

  if (start > latest + 365.2425 * DAY) {
    warnings.push('Vorhersage mehr als ein Jahr nach Analysebeobachtungen.');
  }

  warnings.push(
    'Wasserstand in Originaleinheit und Höhenbezug der Quellen.'
  );
  warnings.push(
    'Astronomische Gezeiten; kein Windstau und keine aktuelle Abflusskorrektur.'
  );

  return {
    datumUTC: datum,
    ergebnisDateiId: id,
    greenwichTransite: greenwichTransitsBetween_(start, end, cache),
    ereignisse: events,
    hinweise: [...new Set(warnings)]
  };
}

function greenwichTransitsBetween_(start, end, cache) {
  const halfMs = HD.MOON_DAY_H * HOUR / 2;
  const firstQ = Math.floor((start - meanUpper_(0)) / halfMs) - 2;
  const lastQ = Math.ceil((end - meanUpper_(0)) / halfMs) + 2;
  const result = [];

  for (let q = firstQ; q <= lastQ; q++) {
    const time = trueTransit_(q, cache);
    if (time < start || time >= end) continue;

    const n = Math.floor(q / 2);
    result.push({
      art: q - 2 * n ? 'unterer' : 'oberer',
      utc: iso_(time),
      transitnummer: n
    });
  }

  return result.sort((a, b) => a.utc.localeCompare(b.utc));
}

function greenwichMondtransiteUTC(datum) {
  requireAstronomy_();
  const start = parseUTCDate_(datum);
  return greenwichTransitsBetween_(start, start + DAY, {});
}

function beispiel20261103() {
  const result = vorhersageUTC('2026-11-03');
  console.log(JSON.stringify(result, null, 2));
  writePrediction_(result);
  return result;
}

function writePrediction_(result) {
  const ss = SpreadsheetApp.openById(result.ergebnisDateiId);
  let sheet = ss.getSheetByName('Vorhersage');

  if (!sheet) {
    sheet = createSheet_(ss, 'Vorhersage', [
      'Art', 'Ereignis UTC', 'Wasserstand',
      'Transitart', 'Transit UTC', 'Transitnummer'
    ]);
  }

  sheet.clearContents();

  const rows = [
    ['Datum UTC', result.datumUTC, '', '', '', ''],
    ['', '', '', '', '', ''],
    [
      'Art', 'Ereignis UTC', 'Wasserstand_Originaleinheit',
      'Transitart', 'Transit UTC', 'Transitnummer'
    ]
  ];

  result.ereignisse.forEach(event => rows.push([
    event.art, event.utc, event.wasserstand,
    event.zugeordneterTransit, event.transitUTC, event.transitnummer
  ]));

  rows.push(['', '', '', '', '', '']);
  rows.push(['Greenwich-Transite des UTC-Tages', '', '', '', '', '']);

  result.greenwichTransite.forEach(transit => rows.push([
    transit.art, transit.utc, '', '', '', transit.transitnummer
  ]));

  rows.push(['', '', '', '', '', '']);

  result.hinweise.forEach(text => {
    rows.push(['Hinweis', text, '', '', '', '']);
  });

  ensureSheetSize_(sheet, rows.length, 6);
  sheet.getRange(1, 1, rows.length, 6).setValues(rows);
}

// ============================================================
// Ganglinienvorhersage
// ============================================================

function loadCurveModels_(ergebnisDateiId) {
  const id = resultId_(ergebnisDateiId);
  const out = SpreadsheetApp.openById(id);
  const metaSheet = out.getSheetByName('Ganglinie_Meta');
  const modelSheet = out.getSheetByName('Ganglinie_Modell');

  if (!metaSheet || !modelSheet) {
    throw new Error('Keine Ganglinienanalyse vorhanden.');
  }

  const text = metaSheet.getRange(2, 2).getValue();
  if (!text) throw new Error('Ganglinien-Metadaten fehlen.');

  const meta = JSON.parse(text);

  if (meta.version !== 3 || !meta.complete) {
    throw new Error('V3-Ganglinienanalyse noch nicht vollständig.');
  }

  if (
    !Number.isInteger(meta.points) ||
    meta.points < 1 ||
    !Number.isFinite(meta.originMs) ||
    !Number.isFinite(meta.stepMs) ||
    meta.stepMs <= 0
  ) {
    throw new Error('Ungültige Ganglinien-Metadaten.');
  }

  const saved = modelSheet.getRange(2, 2, meta.points, 1).getValues();

  const models = saved.map((row, index) => {
    if (!row[0]) throw new Error('Modell fehlt: k=' + (index + 1));
    const model = JSON.parse(row[0]);

    if (
      model.version !== 3 ||
      model.kind !== 'HDDU_HYDROGRAPH' ||
      model.k !== index + 1 ||
      !Array.isArray(model.terms) ||
      !Array.isArray(model.height) ||
      model.height.length !== 1 + 2 * model.terms.length ||
      !model.height.every(Number.isFinite)
    ) {
      throw new Error('Ungültiges Ganglinienmodell k=' + (index + 1));
    }

    model.terms.forEach(term => {
      if (!Array.isArray(term) || !Number.isFinite(term[1])) {
        throw new Error('Ungültige Ganglinienfrequenz.');
      }
    });

    return model;
  });

  return { id: id, meta: meta, models: models };
}

function curveGridValue_(j, bundle, cache) {
  if (cache.has(j)) return cache.get(j);

  const points = bundle.meta.points;
  const n = Math.floor(j / points);
  const index = j - n * points;
  const model = bundle.models[index];

  const height = evaluate_(n, model.terms, model.height);
  if (!Number.isFinite(height)) {
    throw new Error('Nicht endlicher synthetisierter Wasserstand.');
  }

  cache.set(j, height);
  return height;
}

function curveValueAt_(time, bundle, cache) {
  const position =
    (time - bundle.meta.originMs) / bundle.meta.stepMs;

  const left = Math.floor(position);
  const fraction = position - left;
  const a = curveGridValue_(left, bundle, cache);
  const b = curveGridValue_(left + 1, bundle, cache);

  return a + fraction * (b - a);
}

function curveWarnings_(bundle, start, end) {
  const meta = bundle.meta;
  const minTerms = Math.min(...bundle.models.map(m => m.terms.length));
  const maxTerms = Math.max(...bundle.models.map(m => m.terms.length));

  const warnings = [
    'Astronomische Gezeiten; Windstau, Luftdruck und aktuelle ' +
    'Abflussverhältnisse werden nicht vorhergesagt.',
    'Originaleinheit und Höhenbezug der Quellen.',
    'Minütliche Ausgabe durch lineare Interpolation eines ' +
    (meta.stepMs / MINUTE).toFixed(4) +
    '-Minuten-Rasters; keine garantierte Minutengenauigkeit.'
  ];

  if (minTerms < 39) {
    warnings.push(
      'Je Stützstelle wurden ' + minTerms + ' bis ' +
      maxTerms + ' auflösbare Glieder verwendet.'
    );
  }

  const analysisStart = Date.parse(meta.analysisStartUTC);
  const analysisEnd = Date.parse(meta.analysisEndUTCExclusive);

  if (start < analysisStart || end >= analysisEnd) {
    warnings.push('Abfrage enthält zeitliche Extrapolation.');
  }

  if (end > analysisEnd + 365.2425 * DAY) {
    warnings.push(
      'Mehr als ein Jahr nach Analyseende: Änderungen ' +
      'des Pegelregimes und mittleren Wasserstands prüfen.'
    );
  }

  const coverage = Math.min(...bundle.models.map(model =>
    model.availableCount / (meta.nLast - meta.nFirst + 1)
  ));

  if (coverage < 0.6) {
    warnings.push('Mindestens eine Stützstellenreihe hat unter 60 % Belegung.');
  }

  return warnings;
}

function wasserstandUTC(zeitUTC, ergebnisDateiId) {
  const time = parseMinuteUTC_(zeitUTC);
  const bundle = loadCurveModels_(ergebnisDateiId);

  return {
    utc: isoMinute_(time),
    wasserstand: curveValueAt_(time, bundle, new Map()),
    einheit: bundle.meta.unit,
    methode: 'HDdU-Ganglinie mit linearer Stützstelleninterpolation',
    stuetzstellenJeMondtag: bundle.meta.points,
    stuetzstellenAbstandMinuten: bundle.meta.stepMs / MINUTE,
    ergebnisDateiId: bundle.id,
    hinweise: curveWarnings_(bundle, time, time)
  };
}

function wasserstandZeitraumUTC(
  vonUTC, bisUTC, schrittMinuten, ergebnisDateiId
) {
  const start = parseMinuteUTC_(vonUTC);
  const end = parseMinuteUTC_(bisUTC);
  const step = schrittMinuten === undefined ? 1 : schrittMinuten;

  if (!Number.isInteger(step) || step < 1) {
    throw new Error('Schrittweite muss positiv und ganzzahlig sein.');
  }
  if (end < start) throw new Error('Endzeit liegt vor Anfangszeit.');

  const count = Math.floor((end - start) / (step * MINUTE)) + 1;
  if (count > HD_CURVE.MAX_OUTPUT_ROWS) {
    throw new Error('Zu viele Ausgabewerte. Zeitraum aufteilen.');
  }

  const bundle = loadCurveModels_(ergebnisDateiId);
  const cache = new Map();
  const values = [];

  for (let i = 0; i < count; i++) {
    const time = start + i * step * MINUTE;
    values.push({
      utc: isoMinute_(time),
      wasserstand: curveValueAt_(time, bundle, cache)
    });
  }

  return {
    vonUTC: isoMinute_(start),
    bisUTC: isoMinute_(end),
    schrittMinuten: step,
    einheit: bundle.meta.unit,
    methode: 'HDdU-Ganglinie mit linearer Stützstelleninterpolation',
    stuetzstellenJeMondtag: bundle.meta.points,
    ergebnisDateiId: bundle.id,
    werte: values,
    hinweise: curveWarnings_(bundle, start, end)
  };
}

function schreibeWasserstand_(result) {
  const out = SpreadsheetApp.openById(result.ergebnisDateiId);
  let sheet = out.getSheetByName('Wasserstand_Vorhersage');

  if (!sheet) {
    sheet = createSheet_(out, 'Wasserstand_Vorhersage', [
      'UTC', 'Wasserstand_Originaleinheit'
    ]);
  }

  sheet.clearContents();

  const values = result.werte || [{
    utc: result.utc, wasserstand: result.wasserstand
  }];

  const rows = [['UTC', 'Wasserstand_Originaleinheit']];
  values.forEach(value => rows.push([value.utc, value.wasserstand]));
  rows.push(['', '']);
  result.hinweise.forEach(text => rows.push(['Hinweis', text]));

  ensureSheetSize_(sheet, rows.length, 2);

  for (let i = 0; i < rows.length; i += 10000) {
    const block = rows.slice(i, i + 10000);
    sheet.getRange(i + 1, 1, block.length, 2).setValues(block);
  }

  sheet.setFrozenRows(1);
}

function beispielWasserstand20261014() {
  const result = wasserstandUTC('2026-10-14 0927Z');
  console.log(JSON.stringify(result, null, 2));
  schreibeWasserstand_(result);
  return result;
}

function beispielGanglinie20261014() {
  const result = wasserstandZeitraumUTC(
    '2026-10-14 0000Z', '2026-10-14 2359Z', 1
  );

  schreibeWasserstand_(result);
  console.log(result.werte.length + ' Wasserstände geschrieben.');
  return result;
}

// ============================================================
// UTC-Datumsfunktionen
// ============================================================

function parseUTCDate_(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error('Datum als YYYY-MM-DD angeben.');
  }

  const time = Date.parse(text + 'T00:00:00Z');

  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== text
  ) {
    throw new Error('Ungültiges Datum: ' + text);
  }

  return time;
}

function parseMinuteUTC_(text) {
  if (typeof text !== 'string') {
    throw new Error('UTC-Zeit als Zeichenfolge angeben.');
  }

  const m = text.trim().match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):?(\d{2})(?::00)?Z$/
  );

  if (!m) {
    throw new Error('UTC-Format: YYYY-MM-DD HHMMZ oder YYYY-MM-DDTHH:MMZ.');
  }

  const canonical = m[1] + 'T' + m[2] + ':' + m[3] + ':00Z';
  const time = Date.parse(canonical);

  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== canonical.replace('Z', '.000Z')
  ) {
    throw new Error('Ungültige UTC-Zeit: ' + text);
  }

  return time;
}

function iso_(ms) {
  return new Date(Math.round(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoMinute_(ms) {
  return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

// ============================================================
// Tests
// ============================================================

function testZeitumstellung() {
  function assert(condition, message) {
    if (!condition) throw new Error('Test fehlgeschlagen: ' + message);
  }

  function candidate(text) {
    return localUTCCandidates_(text, 'Test');
  }

  assert(
    candidate('01.01.2021 00:00:00')[0] ===
      Date.parse('2020-12-31T23:00:00Z'),
    'Winterzeit'
  );

  assert(
    candidate('01.07.2021 00:00:00')[0] ===
      Date.parse('2021-06-30T22:00:00Z'),
    'Sommerzeit'
  );

  assert(
    candidate('28.03.2021 03:00:00')[0] -
      candidate('28.03.2021 01:59:00')[0] === MINUTE,
    'Frühjahrswechsel'
  );

  const source = {
    label: 'Test',
    startMs: Date.parse('2020-12-31T23:00:00Z'),
    endMs: Date.parse('2021-12-31T23:00:00Z')
  };

  const texts = [['31.10.2021 01:59:00']];

  for (let pass = 0; pass < 2; pass++) {
    for (let minute = 0; minute < 60; minute++) {
      texts.push([
        '31.10.2021 02:' + String(minute).padStart(2, '0') + ':00'
      ]);
    }
  }

  texts.push(['31.10.2021 03:00:00']);

  const levels = texts.map(() => [1]);

  const autumn = convertSourceBlock_(
    source, 2, texts, levels, null
  );

  for (let i = 1; i < autumn.times.length; i++) {
    assert(
      autumn.times[i] - autumn.times[i - 1] === MINUTE,
      'Chronologische doppelte Herbststunde bei Index ' + i
    );
  }

  assert(
    autumn.times[1] === Date.parse('2021-10-31T00:00:00Z'),
    'Erste 02:00 ist MESZ'
  );

  assert(
    autumn.times[61] === Date.parse('2021-10-31T01:00:00Z'),
    'Zweite 02:00 ist MEZ'
  );

  assert(
    candidate('31.10.2021 02:30:00 MESZ')[0] ===
      Date.parse('2021-10-31T00:30:00Z'),
    'Explizite MESZ'
  );

  assert(
    candidate('31.10.2021 02:30:00 MEZ')[0] ===
      Date.parse('2021-10-31T01:30:00Z'),
    'Explizite MEZ'
  );

  const gap = convertSourceBlock_(
    source,
    2,
    [
      ['01.01.2021 00:00:00'],
      ['01.01.2021 00:03:00']
    ],
    [[1], [2]],
    null
  );

  assert(gap.missingInternal === 2, 'Zwei fehlende Minuten');

  let rejected = false;
  try {
    convertSourceBlock_(
      source,
      2,
      [
        ['31.10.2021 01:59:00'],
        ['31.10.2021 02:30:00'],
        ['31.10.2021 03:00:00']
      ],
      [[1], [1], [1]],
      null
    );
  } catch (error) {
    rejected = String(error).includes('nicht eindeutig');
  }

  assert(rejected, 'Mehrdeutige isolierte Herbstzeit muss abgelehnt werden');

  let springRejected = false;
  try {
    candidate('28.03.2021 02:30:00');
  } catch (error) {
    springRejected = String(error).includes('existiert');
  }

  assert(springRejected, 'Nicht existierende Frühjahrszeit');

  console.log(
    'Zeitumstellungstests erfolgreich: Winter, Sommer, ' +
    'Frühjahr, doppelte Herbststunde, explizite Zeitzonen, ' +
    'Messlücke und Ablehnung mehrdeutiger Zeiten.'
  );

  return true;
}

function testAstronomie() {
  requireAstronomy_();

  const examples = [
    [2 * 14468,     '1991-01-01T00:18:00Z'],
    [2 * 14468 + 1, '1991-01-01T12:50:00Z'],
    [2 * 21172,     '2009-12-30T23:12:00Z']
  ];

  const cache = {};

  const result = examples.map(([q, reference]) => {
    const calculated = trueTransit_(q, cache);

    return {
      q: q,
      berechnet: iso_(calculated),
      tabellenwert: reference,
      differenzMinuten:
        (calculated - Date.parse(reference)) / MINUTE
    };
  });

  console.log(JSON.stringify(result, null, 2));
  return result;
}
