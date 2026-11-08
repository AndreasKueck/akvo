/**
 * hddu.gs
 *
 * Hamburg / St. Pauli – HDdU mit GESLA-5-Eingabe.
 *
 * Eigenständiges Analyseprojekt.
 * Astronomy Engine 2.1.19 muss separat vorhanden sein.
 *
 * Quelle:
 *   unkomprimierte GESLA-Textdatei in Google Drive
 *
 * Zeit:
 *   ausschließlich UTC; TIME ZONE HOURS muss 0 sein
 *
 * Höhen:
 *   Meter, Höhenbezug unverändert aus dem Dateikopf
 *
 * Raster:
 *   10 Minuten. Fehlende Positionen werden nicht aufgefüllt.
 *
 * Ablauf:
 *   IMPORT -> EXTRACT -> ESTIMATE -> ASSIGN
 *   -> PEAK_FIT -> CURVE_INIT -> CURVE_SAMPLE
 *   -> CURVE_FIT -> DONE
 *
 * Steuerung:
 *   hdduTests()
 *   hdduStart()
 *   hdduStatus()
 *   hdduWeiter()
 *   hdduFortsetzen()
 *   hdduPause()
 *   hdduStop()
 *
 * Keine amtliche Gezeitenvorausberechnung.
 * Kein Windstau-, Luftdruck- oder Abflussvorhersagemodell.
 */

const HH = Object.freeze({
  SOURCE_FILE_ID: PropertiesService.getScriptProperties().getProperty('SOURCE_FILE_ID'),
  EXPECTED_SITE: 'StPauliTG',
  EXPECTED_CODE: 'StP',
  EXPECTED_DATUM: 'DHHN92 / Amsterdam',

  // null: letzte 19 Kalenderjahre bis zum nominalen Dateiende.
  // Alternativ UTC-Zeichenfolgen, z.B. '2007-01-01T00:00:00Z'.
  START_UTC: null,
  END_UTC_EXCLUSIVE: null,

  STEP_MINUTES: 10,

  // Bewusst konservativ:
  // QC 0 = ungeprüft, QC 2 = bereits interpoliert -> ausgeschlossen.
  ACCEPT_QC: [1],

  CHUNK_BYTES: 512 * 1024,
  EXTRACT_DAYS: 60,
  SAMPLE_MOON_DAYS: 40,
  ASSIGN_BLOCK: 300,

  EXTREME_HALF_MINUTES: 120,
  MAX_PLATEAU_MINUTES: 60,

  // Ausgangspunkt für die Wahl des halbtägigen Intervallzweiges.
  // Kein fest vorgegebenes Ergebnis der Analyse.
  HW_BRANCH_HOURS: 15 + 22 / 60,
  MAX_ASSIGN_ERROR_HOURS: 2.5,

  CURVE_POINTS: 96,

  T0: Date.UTC(1949, 11, 31, 21, 8, 0),
  SYNC_MINUTES: 24.23,

  // Zeitbasis aus der bisherigen Implementierung / BSH 50/2013.
  // Analyse und Synthese verwenden exakt denselben Wert.
  MOON_DAY_HOURS: 2 * 12.4206012,

  STATE_KEY: 'HAMBURG_HDDU_STATE_V4',
  RESULT_KEY: 'HAMBURG_HDDU_RESULT_V4',

  VERSION: 4
});

const HH_MINUTE = 60000;
const HH_HOUR = 3600000;
const HH_DAY = 86400000;
const HH_STEP = HH.STEP_MINUTES * HH_MINUTE;
const HH_PERIOD = HH.MOON_DAY_HOURS * HH_HOUR;
const HH_RAD = Math.PI / 180;

const HH_TERMS = [
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

let HH_INDEX_CACHE = null;
let HH_RAW_CACHE = new Map();

/* ============================================================
 * Steuerung
 * ============================================================ */

function hdduStart() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    hhRequireAstronomy_();

    const old = hhLoadState_();
    if (old && old.stage !== 'DONE') {
      throw new Error(
        'Eine Analyse existiert bereits. Fortsetzen oder hdduStop() ausführen.'
      );
    }

    hhCheckConfig_();

    const file = DriveApp.getFileById(HH.SOURCE_FILE_ID);
    const source = {
      id: file.getId(),
      name: file.getName(),
      size: file.getSize(),
      modified: file.getLastUpdated().getTime()
    };

    if (source.size < 100) {
      throw new Error('Quelldatei ist leer oder zu klein.');
    }

    const first = hhReadByteBlock_(source, 0);
    const header = hhParseHeader_(first.text);
    hhValidateHeader_(header);

    const nominalStart = hhGeslaTime_(header.start);
    const nominalLast = hhGeslaTime_(header.end);
    const nominalEnd = nominalLast + HH_STEP;

    let end = HH.END_UTC_EXCLUSIVE === null
      ? nominalEnd
      : hhParseUTC_(HH.END_UTC_EXCLUSIVE);

    let start;

    if (HH.START_UTC === null) {
      const d = new Date(end);
      d.setUTCFullYear(d.getUTCFullYear() - 19);
      start = Math.max(nominalStart, d.getTime());
    } else {
      start = hhParseUTC_(HH.START_UTC);
    }

    if (
      start < nominalStart ||
      end > nominalEnd ||
      end <= start ||
      (start - nominalStart) % HH_STEP !== 0 ||
      (end - nominalStart) % HH_STEP !== 0
    ) {
      throw new Error('Analysegrenzen passen nicht zum Quellenintervall/Raster.');
    }

    if (end - start < 365 * HH_DAY) {
      throw new Error(
        'Mindestens ein Jahr erforderlich; fachlich werden 19 Jahre empfohlen.'
      );
    }

    hhRemoveTriggers_();

    const ss = SpreadsheetApp.create(
      'Hamburg St. Pauli HDdU ' +
      Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm')
    );
    ss.setSpreadsheetTimeZone('Etc/UTC');

    const info = ss.getSheets()[0];
    info.setName('Info');
    hhResize_(info, 30, 2);

    info.getRange(1, 1, 12, 2).setValues([
      ['Eigenschaft', 'Wert'],
      ['Verfahren', 'HDdU Hamburg GESLA V4'],
      ['Station', HH.EXPECTED_SITE],
      ['Analysebeginn UTC', hhIso_(start)],
      ['Analyseende UTC exklusiv', hhIso_(end)],
      ['Status', 'IMPORT'],
      ['Einheit', 'm'],
      ['Höhenbezug laut Quelle', header.datum],
      ['Zeitbasis', 'UTC; GESLA TIME ZONE HOURS 0'],
      ['Quellraster Minuten', HH.STEP_MINUTES],
      ['QC-Auswahl', JSON.stringify(HH.ACCEPT_QC) + '; Use=1'],
      ['Ganglinienpunkte je Mondtag', HH.CURVE_POINTS]
    ]);

    hhNewSheet_(ss, 'Quelle', ['Eigenschaft', 'Wert']);
    hhWrite_(ss.getSheetByName('Quelle'), 2, [
      ['Dateiname', source.name],
      ['Drive-ID', source.id],
      ['Dateigröße Bytes', source.size],
      ['Datei geändert UTC', hhIso_(source.modified)],
      ['GESLA-Header', JSON.stringify(header)]
    ]);

    hhNewSheet_(ss, 'Rohdaten', ['UTC_ms', 'Wasserstand_m_gueltig']);
    hhNewSheet_(ss, 'Zeitindex', [
      'Startzeile', 'Zeilenzahl', 'Erste_UTC_ms', 'Letzte_UTC_ms'
    ]);
    hhNewSheet_(ss, 'Import_Diagnostik', ['Eigenschaft', 'Wert']);
    hhNewSheet_(ss, 'Extrema', ['UTC_ms', 'Art', 'Wasserstand_m']);
    hhNewSheet_(ss, 'Zuordnung', [
      'q', 'n', 'k', 'Intervall_h', 'Wasserstand_m',
      'Ereignis_UTC_ms', 'Wahrer_Transit_UTC_ms', 'Fehler_h'
    ]);
    hhNewSheet_(ss, 'Modell', ['k', 'JSON']);
    hhNewSheet_(ss, 'Diagnostik', [
      'k', 'Vorhanden', 'Verwendet', 'Glieder',
      'Fit_RMSE_Zeit_min', 'Fit_RMSE_Hoehe_m',
      'Test_N', 'Test_RMSE_Zeit_min', 'Test_RMSE_Hoehe_m',
      'Test_Bias_Zeit_min', 'Test_Bias_Hoehe_m', 'Test_Glieder'
    ]);
    hhNewSheet_(ss, 'Arbeitsmodell', ['Eigenschaft', 'JSON']);

    const state = {
      version: HH.VERSION,
      signature: hhSignature_(),
      stage: 'IMPORT',
      outputId: ss.getId(),
      source: source,
      header: header,
      start: start,
      end: end,
      nominalStart: nominalStart,
      nominalLast: nominalLast,
      byteOffset: 0,
      physicalLines: 0,
      previousTime: null,
      firstTime: null,
      imported: 0,
      accepted: 0,
      selected: 0,
      selectedAccepted: 0,
      missingSlots: 0,
      qcCounts: [0, 0, 0, 0, 0, 0],
      useZero: 0,
      nullCount: 0,
      nonTenMinuteSteps: 0,
      committed: {
        Rohdaten: 1,
        Zeitindex: 1,
        Extrema: 1,
        Zuordnung: 1
      },
      createdUTC: new Date().toISOString()
    };

    hhSaveState_(state);
    PropertiesService.getScriptProperties()
      .setProperty(HH.RESULT_KEY, ss.getId());

    hhCreateTrigger_();

    console.log('Ergebnis: ' + ss.getUrl());
    console.log('Zeitraum: ' + hhIso_(start) + ' bis ' + hhIso_(end));
    return ss.getUrl();

  } finally {
    lock.releaseLock();
  }
}

function hdduWeiter() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    const s = hhLoadState_();

    if (!s || s.stage === 'DONE') {
      hhRemoveTriggers_();
      return;
    }

    if (s.version !== HH.VERSION || s.signature !== hhSignature_()) {
      throw new Error('Konfiguration/Programmversion passt nicht zum Arbeitszustand.');
    }

    HH_INDEX_CACHE = null;
    HH_RAW_CACHE = new Map();

    const ss = SpreadsheetApp.openById(s.outputId);
    hhRollbackAppends_(ss, s);

    switch (s.stage) {
      case 'IMPORT':
        hhImportBlock_(ss, s);
        break;
      case 'EXTRACT':
        hhExtractBlock_(ss, s);
        break;
      case 'ESTIMATE':
        hhEstimate_(ss, s);
        break;
      case 'ASSIGN':
        hhAssignBlock_(ss, s);
        break;
      case 'PEAK_FIT':
        hhFitStep_(ss, s, false);
        break;
      case 'CURVE_INIT':
        hhCurveInit_(ss, s);
        break;
      case 'CURVE_SAMPLE':
        hhCurveSample_(ss, s);
        break;
      case 'CURVE_FIT':
        hhFitStep_(ss, s, true);
        break;
      default:
        throw new Error('Unbekannte Stufe: ' + s.stage);
    }

    delete s.lastError;
    ss.getSheetByName('Info').getRange('B6').setValue(s.stage);
    SpreadsheetApp.flush();

    Object.keys(s.committed).forEach(name => {
      s.committed[name] = ss.getSheetByName(name).getLastRow();
    });

    hhSaveState_(s);

    if (s.stage === 'DONE') {
      hhRemoveTriggers_();
      console.log('Fertig: ' + ss.getUrl());
    }

  } catch (error) {
    hhRemoveTriggers_();

    const committed = hhLoadState_();
    if (committed) {
      committed.lastError = String(error);
      hhSaveState_(committed);
    }

    console.error(error && error.stack ? error.stack : String(error));
    throw error;

  } finally {
    lock.releaseLock();
  }
}

function hdduStatus() {
  const s = hhLoadState_();
  console.log(JSON.stringify(s, null, 2));

  if (s) {
    console.log('https://docs.google.com/spreadsheets/d/' + s.outputId);
  }

  return s;
}

function hdduFortsetzen() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const s = hhLoadState_();

    if (!s || s.stage === 'DONE') {
      throw new Error('Keine unvollständige Analyse vorhanden.');
    }

    if (s.signature !== hhSignature_()) {
      throw new Error('Konfiguration wurde geändert.');
    }

    delete s.lastError;
    hhSaveState_(s);
    hhRemoveTriggers_();
    hhCreateTrigger_();

    console.log('Fortsetzung aktiviert: ' + s.stage);
  } finally {
    lock.releaseLock();
  }
}

function hdduPause() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    hhRemoveTriggers_();
    console.log('Pausiert. Zustand bleibt erhalten.');
  } finally {
    lock.releaseLock();
  }
}

function hdduStop() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    hhRemoveTriggers_();
    PropertiesService.getScriptProperties().deleteProperty(HH.STATE_KEY);
    console.log('Arbeitszustand verworfen. Ergebnisdateien bleiben erhalten.');
  } finally {
    lock.releaseLock();
  }
}

function hhCreateTrigger_() {
  ScriptApp.newTrigger('hdduWeiter').timeBased().everyMinutes(5).create();
}

function hhRemoveTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'hdduWeiter') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function hhLoadState_() {
  const text = PropertiesService.getScriptProperties()
    .getProperty(HH.STATE_KEY);
  return text ? JSON.parse(text) : null;
}

function hhSaveState_(s) {
  const text = JSON.stringify(s);

  // Apps-Script-Properties haben ein begrenztes Einzelwertvolumen.
  // Vorläufige Koeffizienten werden deshalb in einem Blatt gespeichert.
  if (Utilities.newBlob(text).getBytes().length > 8500) {
    throw new Error('Arbeitszustand zu groß für Script Properties.');
  }

  PropertiesService.getScriptProperties().setProperty(HH.STATE_KEY, text);
}

function hhSignature_() {
  return JSON.stringify({
    algorithm: 'hamburg-gesla-v4-1',
    config: HH,
    terms: HH_TERMS
  });
}

function hhCheckConfig_() {
  if (
    !HH.SOURCE_FILE_ID ||
    HH.SOURCE_FILE_ID.indexOf('HIER_') === 0 ||
    HH_TERMS.length !== 39 ||
    !Number.isInteger(HH.CURVE_POINTS) ||
    HH.CURVE_POINTS < 96 ||
    HH.CURVE_POINTS > 288 ||
    HH.STEP_MINUTES !== 10 ||
    !HH.ACCEPT_QC.length ||
    HH.ACCEPT_QC.some(q => ![0, 1, 2].includes(q))
  ) {
    throw new Error('Konfiguration prüfen, insbesondere SOURCE_FILE_ID.');
  }
}

/* ============================================================
 * Tabellen
 * ============================================================ */

function hhResize_(sheet, rows, columns) {
  if (sheet.getMaxColumns() > columns) {
    sheet.deleteColumns(columns + 1, sheet.getMaxColumns() - columns);
  }
  if (sheet.getMaxColumns() < columns) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(), columns - sheet.getMaxColumns()
    );
  }
  if (sheet.getMaxRows() < rows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  }
}

function hhNewSheet_(ss, name, headers) {
  const sheet = ss.insertSheet(name);
  hhResize_(sheet, 2, headers.length);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}

function hhWrite_(sheet, firstRow, rows) {
  if (!rows.length) return;
  hhResize_(sheet, firstRow + rows.length - 1, rows[0].length);
  sheet.getRange(firstRow, 1, rows.length, rows[0].length).setValues(rows);
}

function hhAppend_(sheet, rows) {
  hhWrite_(sheet, sheet.getLastRow() + 1, rows);
}

function hhRollbackAppends_(ss, s) {
  Object.keys(s.committed).forEach(name => {
    const sh = ss.getSheetByName(name);
    const count = sh.getLastRow() - s.committed[name];
    if (count > 0) {
      sh.getRange(
        s.committed[name] + 1, 1, count, sh.getMaxColumns()
      ).clearContent();
    }
  });
}

/* ============================================================
 * Byteweises Lesen der großen Drive-Textdatei
 *
 * Kein vollständiges Laden der Datei in den Arbeitsspeicher.
 * Der gespeicherte Offset liegt immer hinter einem LF.
 * ============================================================ */

function hhReadByteBlock_(source, offset) {
  const last = Math.min(source.size - 1, offset + HH.CHUNK_BYTES - 1);

  const response = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' +
      encodeURIComponent(source.id) + '?alt=media',
    {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        Range: 'bytes=' + offset + '-' + last
      },
      muteHttpExceptions: true
    }
  );

  const code = response.getResponseCode();
  const bytes = response.getContent();

  if (code === 206) {
    const headers = response.getAllHeaders();
    const key = Object.keys(headers).find(
      k => k.toLowerCase() === 'content-range'
    );
    const value = key ? String(headers[key]) : '';
    const m = value.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);

    if (
      !m ||
      Number(m[1]) !== offset ||
      Number(m[2]) !== last ||
      Number(m[3]) !== source.size ||
      bytes.length !== last - offset + 1
    ) {
      throw new Error('Unerwartete Content-Range-Antwort von Drive.');
    }
  } else if (!(
    code === 200 &&
    offset === 0 &&
    source.size <= HH.CHUNK_BYTES &&
    bytes.length === source.size
  )) {
    throw new Error(
      'Drive-Bereichsabruf fehlgeschlagen, HTTP ' + code +
      '. Unkomprimierte normale Textdatei und Berechtigungen prüfen.'
    );
  }

  let used = bytes.length;
  const fileEnd = offset + bytes.length === source.size;

  if (!fileEnd) {
    while (used > 0 && bytes[used - 1] !== 10) used--;
    if (!used) throw new Error('Keine vollständige Zeile im Leseblock.');
  }

  return {
    text: Utilities.newBlob(bytes.slice(0, used))
      .getDataAsString('UTF-8'),
    next: offset + used
  };
}

/* ============================================================
 * GESLA-Parser
 * ============================================================ */

function hhParseHeader_(text) {
  const h = {};
  let foundData = false;

  const mappings = [
    ['FORMAT VERSION', 'format'],
    ['SITE NAME', 'site'],
    ['SITE CODE', 'code'],
    ['TIME ZONE HOURS', 'timezone'],
    ['DATUM INFORMATION', 'datum'],
    ['NULL VALUE', 'nullValue'],
    ['START DATE/TIME', 'start'],
    ['END DATE/TIME', 'end'],
    ['LATITUDE', 'latitude'],
    ['LONGITUDE', 'longitude'],
    ['CONTRIBUTOR', 'contributor']
  ];

  for (let line of text.replace(/^\uFEFF/, '').split('\n')) {
    line = line.trim();
    if (!line) continue;

    if (!line.startsWith('#')) {
      foundData = true;
      break;
    }

    const body = line.slice(1).trim();

    for (const [label, key] of mappings) {
      if (body.startsWith(label + ' ')) {
        // WEBSITE/CONTACT sind keine Contributor-Bezeichnung.
        if (
          key === 'contributor' &&
          /^CONTRIBUTOR (WEBSITE|CONTACT)\b/.test(body)
        ) {
          continue;
        }
        h[key] = body.slice(label.length).trim();
      }
    }
  }

  if (!foundData) {
    throw new Error('GESLA-Kopf zu lang oder keine Daten im ersten Block.');
  }

  return h;
}

function hhValidateHeader_(h) {
  if (!h.format || !/^5\.0(?:\s|$)/.test(h.format)) {
    throw new Error('GESLA FORMAT VERSION 5.0 erwartet.');
  }

  if (h.site !== HH.EXPECTED_SITE || h.code !== HH.EXPECTED_CODE) {
    throw new Error('Quelldatei gehört nicht zur konfigurierten Station.');
  }

  if (h.timezone === undefined || Number(h.timezone) !== 0) {
    throw new Error('Diese Fassung erwartet GESLA TIME ZONE HOURS 0.');
  }

  if (h.datum !== HH.EXPECTED_DATUM) {
    throw new Error('Unerwarteter Höhenbezug: ' + h.datum);
  }

  if (
    h.nullValue === undefined ||
    !Number.isFinite(Number(h.nullValue))
  ) {
    throw new Error('NULL VALUE fehlt oder ist ungültig.');
  }

  const start = hhGeslaTime_(h.start);
  const end = hhGeslaTime_(h.end);

  if (
    end <= start ||
    start % HH_STEP !== 0 ||
    end % HH_STEP !== 0
  ) {
    throw new Error('Ungültige Start-/Endangabe im Dateikopf.');
  }
}

function hhGeslaTime_(text) {
  if (
    typeof text !== 'string' ||
    !/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
  ) {
    throw new Error('Ungültige GESLA-Zeit: ' + text);
  }

  return hhParseUTC_(text.replace(/\//g, '-').replace(' ', 'T') + 'Z');
}

function hhParseGeslaRow_(line, header, location) {
  const m = line.trim().match(
    /^(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+([0-5])\s+([01])$/
  );

  if (!m) {
    throw new Error(location + ': Ungültige GESLA-Datenzeile: ' + line);
  }

  const time = hhGeslaTime_(m[1] + ' ' + m[2]);
  const level = Number(m[3]);
  const qc = Number(m[4]);
  const use = Number(m[5]);

  if (!Number.isFinite(level)) {
    throw new Error(location + ': Nicht endlicher Wasserstand.');
  }

  if (time % HH_STEP !== 0) {
    throw new Error(
      location + ': Zeitstempel liegt nicht im 10-Minuten-UTC-Raster. ' +
      'Diese Fassung verarbeitet keinen abweichenden Messrhythmus.'
    );
  }

  const isNull = Math.abs(level - Number(header.nullValue)) < 1e-10;
  const valid = !isNull && use === 1 && HH.ACCEPT_QC.includes(qc);

  return { time: time, level: level, qc: qc, use: use,
    isNull: isNull, valid: valid };
}

function hhImportBlock_(ss, s) {
  const file = DriveApp.getFileById(s.source.id);

  if (
    file.getSize() !== s.source.size ||
    file.getLastUpdated().getTime() !== s.source.modified
  ) {
    throw new Error('Quelldatei wurde während des Imports verändert.');
  }

  const block = hhReadByteBlock_(s.source, s.byteOffset);
  const lines = block.text.replace(/^\uFEFF/, '').split('\n');

  // Ein abschließendes LF erzeugt keinen zusätzlichen physischen Datensatz.
  if (lines[lines.length - 1] === '') lines.pop();

  const selected = [];

  for (const rawLine of lines) {
    s.physicalLines++;
    const line = rawLine.trim();

    if (!line) continue;

    if (line.startsWith('#')) {
      if (s.previousTime !== null) {
        throw new Error('Unerwarteter Kommentar/Header innerhalb der Daten.');
      }
      continue;
    }

    const r = hhParseGeslaRow_(
      line, s.header, 'Zeile ' + s.physicalLines
    );

    if (
      r.time < s.nominalStart ||
      r.time > s.nominalLast
    ) {
      throw new Error('Messzeit liegt außerhalb der Header-Grenzen.');
    }

    if (s.previousTime !== null) {
      const difference = r.time - s.previousTime;

      if (difference <= 0) {
        throw new Error(
          'Doppelter oder nicht chronologischer UTC-Zeitstempel: ' +
          hhIso_(r.time)
        );
      }

      if (difference % HH_STEP !== 0) {
        throw new Error('Unvereinbarer Messrhythmus.');
      }

      s.missingSlots += difference / HH_STEP - 1;
      if (difference !== HH_STEP) s.nonTenMinuteSteps++;
    } else {
      s.firstTime = r.time;
    }

    s.previousTime = r.time;
    s.imported++;
    s.qcCounts[r.qc]++;
    if (r.use === 0) s.useZero++;
    if (r.isNull) s.nullCount++;
    if (r.valid) s.accepted++;

    if (r.time >= s.start && r.time < s.end) {
      selected.push([r.time, r.valid ? r.level : '']);
      s.selected++;
      if (r.valid) s.selectedAccepted++;
    }
  }

  if (selected.length) {
    const raw = ss.getSheetByName('Rohdaten');
    const firstRow = raw.getLastRow() + 1;

    hhWrite_(raw, firstRow, selected);
    hhAppend_(ss.getSheetByName('Zeitindex'), [[
      firstRow,
      selected.length,
      selected[0][0],
      selected[selected.length - 1][0]
    ]]);
  }

  s.byteOffset = block.next;

  if (s.byteOffset === s.source.size) {
    if (
      s.firstTime !== s.nominalStart ||
      s.previousTime !== s.nominalLast
    ) {
      throw new Error(
        'Tatsächlicher Dateianfang/-schluss stimmt nicht mit dem Header überein. ' +
        'Möglicherweise wurde nur ein Dateiausschnitt hochgeladen.'
      );
    }

    if (s.selectedAccepted < 10000) {
      throw new Error('Zu wenige gültige Messwerte im Analysezeitraum.');
    }

    const capacity = (s.end - s.start) / HH_STEP;

    hhWrite_(ss.getSheetByName('Import_Diagnostik'), 2, [
      ['Physische Zeilen', s.physicalLines],
      ['Zeitstempel gesamte Datei', s.imported],
      ['Akzeptierte Werte gesamte Datei', s.accepted],
      ['Fehlende Rasterpositionen intern gesamte Datei', s.missingSlots],
      ['Abstände größer als 10 Minuten', s.nonTenMinuteSteps],
      ['QC-Zählung 0 bis 5', JSON.stringify(s.qcCounts)],
      ['Use-in-analysis = 0', s.useZero],
      ['NULL-Werte', s.nullCount],
      ['Soll-Rasterpositionen Analyse', capacity],
      ['Zeitstempel Analyse', s.selected],
      ['Fehlende Zeitstempel Analyse', capacity - s.selected],
      ['Akzeptierte Messwerte Analyse', s.selectedAccepted],
      ['Abgelehnte Messwerte Analyse', s.selected - s.selectedAccepted],
      ['Gültige Belegung Analyse', s.selectedAccepted / capacity],
      ['Erste Messzeit UTC', hhIso_(s.firstTime)],
      ['Letzte Messzeit UTC', hhIso_(s.previousTime)]
    ]);

    s.nextTime = s.start;
    s.stage = 'EXTRACT';
  }
}

/* ============================================================
 * Rasterleser
 * ============================================================ */

function hhTimeIndex_(ss) {
  if (HH_INDEX_CACHE) return HH_INDEX_CACHE;

  const sh = ss.getSheetByName('Zeitindex');
  const count = sh.getLastRow() - 1;

  if (count < 1) throw new Error('Zeitindex fehlt.');

  HH_INDEX_CACHE = sh.getRange(2, 1, count, 4).getValues()
    .map(r => ({
      row: Number(r[0]),
      count: Number(r[1]),
      first: Number(r[2]),
      last: Number(r[3])
    }));

  return HH_INDEX_CACHE;
}

function hhReadGrid_(ss, s, from, to) {
  if (
    to < from ||
    (from - s.start) % HH_STEP !== 0 ||
    (to - from) % HH_STEP !== 0
  ) {
    throw new Error('Ungültiger Rasterlesebereich.');
  }

  const values = new Float64Array((to - from) / HH_STEP);
  values.fill(NaN);

  if (!values.length) return values;

  for (const e of hhTimeIndex_(ss)) {
    if (e.last < from || e.first >= to) continue;

    let rows = HH_RAW_CACHE.get(e.row);

    if (!rows) {
      rows = ss.getSheetByName('Rohdaten')
        .getRange(e.row, 1, e.count, 2).getValues();

      if (HH_RAW_CACHE.size >= 4) {
        HH_RAW_CACHE.delete(HH_RAW_CACHE.keys().next().value);
      }

      HH_RAW_CACHE.set(e.row, rows);
    }

    for (const r of rows) {
      const time = Number(r[0]);
      if (time < from || time >= to) continue;

      const i = (time - from) / HH_STEP;

      if (!Number.isInteger(i)) {
        throw new Error('Rohdaten enthalten einen rasterfremden Zeitstempel.');
      }

      values[i] = typeof r[1] === 'number' && Number.isFinite(r[1])
        ? r[1] : NaN;
    }
  }

  return values;
}

function hhInterpolateGrid_(values, from, time) {
  const position = (time - from) / HH_STEP;
  const nearest = Math.round(position);

  if (Math.abs(position - nearest) < 1e-10) {
    return nearest >= 0 && nearest < values.length
      ? values[nearest] : NaN;
  }

  const left = Math.floor(position);
  if (left < 0 || left + 1 >= values.length) return NaN;

  const a = values[left];
  const b = values[left + 1];

  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;

  return a + (position - left) * (b - a);
}

/* ============================================================
 * Extrema auf dem 10-Minuten-Raster
 *
 * Keine künstliche Erzeugung von Minutenmessungen.
 * Keine gleitende Mittelung: Sie könnte besonders NW abflachen.
 *
 * Lokale Parabel durch drei Originalstützstellen, wenn der
 * Scheitel eindeutig ist. Plateaus: zeitliche Mitte.
 * ============================================================ */

function hhExtractBlock_(ss, s) {
  const coreStart = s.nextTime;
  const coreEnd = Math.min(s.end, coreStart + HH.EXTRACT_DAYS * HH_DAY);

  const margin = (
    HH.EXTREME_HALF_MINUTES + HH.MAX_PLATEAU_MINUTES + 20
  ) * HH_MINUTE;

  const from = Math.max(s.start, coreStart - margin);
  const to = Math.min(s.end, coreEnd + margin);
  const a = hhReadGrid_(ss, s, from, to);
  const half = HH.EXTREME_HALF_MINUTES / HH.STEP_MINUTES;
  const rows = [];

  for (const high of [true, false]) {
    const candidates = new Uint8Array(a.length);

    for (let i = half; i < a.length - half; i++) {
      if (!Number.isFinite(a[i])) continue;

      let good = true;

      for (let j = i - half; j <= i + half; j++) {
        if (
          !Number.isFinite(a[j]) ||
          (high ? a[j] > a[i] : a[j] < a[i])
        ) {
          good = false;
          break;
        }
      }

      if (good) candidates[i] = 1;
    }

    for (let i = half; i < a.length - half; i++) {
      if (!candidates[i]) continue;

      const first = i;
      while (
        i + 1 < a.length - half &&
        candidates[i + 1] &&
        a[i + 1] === a[first]
      ) {
        i++;
      }
      const last = i;

      if ((last - first) * HH.STEP_MINUTES > HH.MAX_PLATEAU_MINUTES) {
        continue;
      }

      const centre = Math.floor((first + last) / 2);
      const value = a[centre];

      if (!(high
        ? value > a[centre - half] && value > a[centre + half]
        : value < a[centre - half] && value < a[centre + half]
      )) {
        continue;
      }

      // Eigentümer des Ereignisses ist der Block seiner Rastermitte.
      const centreTime = from + centre * HH_STEP;
      if (centreTime < coreStart || centreTime >= coreEnd) continue;

      let offset = (first + last) / 2 - centre;
      let height = value;

      if (first === last) {
        const left = a[centre - 1];
        const right = a[centre + 1];
        const curvature = left - 2 * value + right;

        if (high ? curvature < 0 : curvature > 0) {
          const d = (left - right) / (2 * curvature);

          if (Number.isFinite(d) && Math.abs(d) <= 0.5 + 1e-10) {
            offset = d;
            height = value -
              (right - left) * (right - left) / (8 * curvature);
          }
        }
      }

      const eventTime = centreTime + offset * HH_STEP;
      if (eventTime < s.start || eventTime >= s.end) continue;

      rows.push([eventTime, high ? 'HW' : 'NW', height]);
    }
  }

  rows.sort((a, b) => a[0] - b[0]);
  hhAppend_(ss.getSheetByName('Extrema'), rows);

  s.nextTime = coreEnd;
  if (coreEnd >= s.end) s.stage = 'ESTIMATE';
}

/* ============================================================
 * Greenwich-Mondtransite
 * ============================================================ */

function hhMeanUpper_(n) {
  return HH.T0 + HH.SYNC_MINUTES * HH_MINUTE + n * HH_PERIOD;
}

function hhMeanHalf_(q) {
  return hhMeanUpper_(0) + q * HH_PERIOD / 2;
}

function hhRequireAstronomy_() {
  if (typeof Astronomy === 'undefined') {
    throw new Error('Astronomy Engine fehlt.');
  }

  [
    'AstroTime', 'GeoMoon', 'Rotation_EQJ_EQD',
    'RotateVector', 'EquatorFromVector', 'SiderealTime'
  ].forEach(name => {
    if (typeof Astronomy[name] !== 'function') {
      throw new Error('Astronomy-Funktion fehlt: ' + name);
    }
  });
}

function hhWrap180_(x) {
  return ((x + 180) % 360 + 360) % 360 - 180;
}

function hhMoonAngle_(ms) {
  const time = new Astronomy.AstroTime(new Date(ms));
  const eqj = Astronomy.GeoMoon(time);
  const eqd = Astronomy.RotateVector(
    Astronomy.Rotation_EQJ_EQD(time), eqj
  );
  const equatorial = Astronomy.EquatorFromVector(eqd);

  return hhWrap180_(
    15 * (Astronomy.SiderealTime(time) - equatorial.ra)
  );
}

function hhTrueTransit_(q, cache) {
  if (cache.has(q)) return cache.get(q);

  const lower = ((q % 2) + 2) % 2;
  const target = lower ? 180 : 0;
  let time = hhMeanHalf_(q);

  for (let i = 0; i < 10; i++) {
    const error = hhWrap180_(hhMoonAngle_(time) - target);
    const delta = 5 * HH_MINUTE;
    const speed = hhWrap180_(
      hhMoonAngle_(time + delta) - hhMoonAngle_(time - delta)
    ) / (2 * delta / HH_HOUR);

    if (!(speed > 10 && speed < 20)) {
      throw new Error('Unplausible Mond-Stundenwinkelgeschwindigkeit.');
    }

    const correction = error / speed * HH_HOUR;
    time -= correction;

    if (Math.abs(correction) < 100) break;
  }

  if (
    Math.abs(hhWrap180_(hhMoonAngle_(time) - target)) > 0.001 ||
    Math.abs(time - hhMeanHalf_(q)) > 4 * HH_HOUR
  ) {
    throw new Error('Mondtransit nicht sicher bestimmt: q=' + q);
  }

  cache.set(q, time);
  return time;
}

/* ============================================================
 * Intervallschätzung und Zuordnung
 * ============================================================ */

function hhCircularLag_(rows, branch) {
  if (!rows.length) throw new Error('Keine Ereignisse zur Intervallschätzung.');

  const halfHours = HH.MOON_DAY_HOURS / 2;
  let c = 0;
  let s = 0;

  rows.forEach(r => {
    const hours = (Number(r[0]) - hhMeanUpper_(0)) / HH_HOUR;
    const angle = 2 * Math.PI * hours / halfHours;
    c += Math.cos(angle);
    s += Math.sin(angle);
  });

  let lag = Math.atan2(s, c) * halfHours / (2 * Math.PI);
  lag += Math.round((branch - lag) / halfHours) * halfHours;

  return {
    lag: lag,
    coherence: Math.hypot(c, s) / rows.length
  };
}

function hhEstimate_(ss, s) {
  const sh = ss.getSheetByName('Extrema');
  const count = sh.getLastRow() - 1;

  if (count < 400) throw new Error('Zu wenige erkannte Extrema.');

  const rows = sh.getRange(2, 1, count, 3).getValues();
  const hw = hhCircularLag_(
    rows.filter(r => r[1] === 'HW'), HH.HW_BRANCH_HOURS
  );
  const nw = hhCircularLag_(
    rows.filter(r => r[1] === 'NW'),
    hw.lag + HH.MOON_DAY_HOURS / 4
  );

  if (hw.coherence < 0.5 || nw.coherence < 0.5) {
    throw new Error('Unzureichende halbtägige Phasenkohärenz.');
  }

  const ebb = nw.lag - hw.lag;
  if (!(ebb > 2 && ebb < 11)) {
    throw new Error('Unplausible mittlere Dauer HW -> NW.');
  }

  s.hwLag = hw.lag;
  s.nwLag = nw.lag;
  s.extremaCount = count;
  s.nextEvent = 0;
  s.assignedCount = 0;
  s.stage = 'ASSIGN';

  hhWrite_(ss.getSheetByName('Info'), 14, [
    ['Geschätztes HW-Intervall h', hw.lag],
    ['Geschätztes NW-Intervall h', nw.lag],
    ['HW-Phasenkohärenz', hw.coherence],
    ['NW-Phasenkohärenz', nw.coherence],
    ['Mittlere Dauer HW -> NW h', ebb],
    ['Extrema', count]
  ]);
}

function hhAssignBlock_(ss, s) {
  hhRequireAstronomy_();

  const size = Math.min(HH.ASSIGN_BLOCK, s.extremaCount - s.nextEvent);
  const rows = ss.getSheetByName('Extrema')
    .getRange(2 + s.nextEvent, 1, size, 3).getValues();

  const cache = new Map();
  const output = [];

  for (const row of rows) {
    const time = Number(row[0]);
    const high = row[1] === 'HW';
    const lag = high ? s.hwLag : s.nwLag;

    const initial = Math.round(
      (time - hhMeanUpper_(0) - lag * HH_HOUR) / (HH_PERIOD / 2)
    );

    let best = null;

    for (let q = initial - 1; q <= initial + 1; q++) {
      const transit = hhTrueTransit_(q, cache);
      const error = Math.abs((time - transit) / HH_HOUR - lag);

      if (!best || error < best.error) {
        best = { q: q, transit: transit, error: error };
      }
    }

    if (best.error > HH.MAX_ASSIGN_ERROR_HOURS) continue;

    const n = Math.floor(best.q / 2);
    const lower = best.q - 2 * n;
    const k = 1 + 2 * lower + (high ? 0 : 1);

    output.push([
      best.q,
      n,
      k,
      (time - hhMeanUpper_(n)) / HH_HOUR,
      Number(row[2]),
      time,
      best.transit,
      best.error
    ]);
  }

  hhAppend_(ss.getSheetByName('Zuordnung'), output);
  s.assignedCount += output.length;
  s.nextEvent += size;

  if (s.nextEvent >= s.extremaCount) {
    s.stage = 'PEAK_FIT';
    s.fitK = 1;
    s.fitPhase = 'TRAIN_FIRST';

    hhWrite_(ss.getSheetByName('Info'), 21, [
      ['Zugeordnete Extrema', s.assignedCount],
      ['Nicht zugeordnete Extrema', s.extremaCount - s.assignedCount]
    ]);
  }
}

function hhPeakRows_(ss, k) {
  const sh = ss.getSheetByName('Zuordnung');
  const count = sh.getLastRow() - 1;

  if (count < 400) throw new Error('Zu wenige zugeordnete Extrema.');

  const all = sh.getRange(2, 1, count, 8).getValues();
  const unique = new Map();

  for (const r of all) {
    const event = {
      n: Number(r[1]),
      k: Number(r[2]),
      y: [Number(r[3]), Number(r[4])],
      time: Number(r[5]),
      score: Number(r[7])
    };

    const key = event.n + ':' + event.k;
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
      const duration = (low.time - event.time) / HH_HOUR;
      if (!(duration > 2 && duration < 11)) {
        invalid.add(key);
        invalid.add(lowKey);
      }
    }
  }

  return Array.from(unique.entries())
    .filter(([key, event]) => event.k === k && !invalid.has(key))
    .map(([, event]) => event)
    .sort((a, b) => a.n - b.n);
}

/* ============================================================
 * Statistik, Gliederauswahl, QR-Ausgleichung
 * ============================================================ */

function hhStats_(values) {
  if (!values.length) throw new Error('Leere statistische Stichprobe.');

  const mean = values.reduce((sum, x) => sum + x, 0) / values.length;
  const variance = values.reduce(
    (sum, x) => sum + (x - mean) * (x - mean), 0
  ) / Math.max(1, values.length - 1);

  return { mean: mean, sd: Math.sqrt(variance) };
}

function hhInside3_(x, stat) {
  return Math.abs(x - stat.mean) <= Math.max(3 * stat.sd, 1e-10);
}

function hhRMSE_(values) {
  if (!values.length) return null;
  return Math.sqrt(
    values.reduce((sum, x) => sum + x * x, 0) / values.length
  );
}

function hhSelectTerms_(rows) {
  if (rows.length < 2) throw new Error('Zu wenige Beobachtungen.');

  const span = rows[rows.length - 1].n - rows[0].n;
  if (!(span > 60)) throw new Error('Zu kurze Transitspanne.');

  const resolution = 360 / span;
  const selected = [];

  for (const term of HH_TERMS.slice().sort((a, b) => a[2] - b[2])) {
    if (term[1] < resolution) continue;

    if (selected.every(other =>
      Math.abs(term[1] - other[1]) >= resolution
    )) {
      selected.push(term);
    }
  }

  return selected.sort((a, b) => a[1] - b[1]);
}

function hhDesign_(n, terms) {
  const row = [1];

  for (const term of terms) {
    const angle = ((term[1] * n) % 360) * HH_RAD;
    row.push(Math.cos(angle), Math.sin(angle));
  }

  return row;
}

function hhEvaluate_(n, terms, coefficients) {
  let result = coefficients[0];

  for (let j = 0; j < terms.length; j++) {
    const angle = ((terms[j][1] * n) % 360) * HH_RAD;
    result += coefficients[1 + 2 * j] * Math.cos(angle);
    result += coefficients[2 + 2 * j] * Math.sin(angle);
  }

  if (!Number.isFinite(result)) {
    throw new Error('Nicht endliches Modellergebnis.');
  }

  return result;
}

function hhInitialFilter_(rows) {
  if (!rows.length) throw new Error('Leere Modellreihe.');

  const dimensions = rows[0].y.length;
  const stats = [];

  for (let d = 0; d < dimensions; d++) {
    stats.push(hhStats_(rows.map(r => r.y[d])));
  }

  return rows.filter(r =>
    r.y.every((value, d) => hhInside3_(value, stats[d]))
  );
}

function hhFit_(rows, terms) {
  const p = 1 + 2 * terms.length;

  if (rows.length < Math.max(100, 3 * p)) {
    throw new Error('Zu wenige Beobachtungen für den gewählten Gliedersatz.');
  }

  const matrix = hhQR_(
    rows.map(r => hhDesign_(r.n, terms)),
    rows.map(r => r.y)
  );

  const dimensions = rows[0].y.length;
  const coefficients = [];

  for (let d = 0; d < dimensions; d++) {
    coefficients.push(matrix.map(r => r[d]));
  }

  return coefficients;
}

function hhFirstFit_(rows) {
  const used = hhInitialFilter_(rows);
  const terms = hhSelectTerms_(used);

  return {
    terms: terms,
    coefficients: hhFit_(used, terms)
  };
}

function hhSecondFit_(rows, first) {
  let used = hhInitialFilter_(rows);
  const dimensions = used[0].y.length;

  const residuals = used.map(r =>
    r.y.map((value, d) =>
      value - hhEvaluate_(r.n, first.terms, first.coefficients[d])
    )
  );

  const stats = [];

  for (let d = 0; d < dimensions; d++) {
    stats.push(hhStats_(residuals.map(r => r[d])));
  }

  used = used.filter((r, i) =>
    residuals[i].every((value, d) => hhInside3_(value, stats[d]))
  );

  const terms = hhSelectTerms_(used);
  const coefficients = hhFit_(used, terms);

  return {
    terms: terms,
    coefficients: coefficients,
    usedCount: used.length,
    nMin: used[0].n,
    nMax: used[used.length - 1].n,
    rmse: coefficients.map((c, d) =>
      hhRMSE_(used.map(r => r.y[d] - hhEvaluate_(r.n, terms, c)))
    )
  };
}

/**
 * Householder-QR, mehrere rechte Seiten.
 * Keine Normalgleichungen.
 */
function hhQR_(inputA, inputB) {
  if (!inputA.length || inputA.length !== inputB.length) {
    throw new Error('Ungültige Ausgleichungsdimensionen.');
  }

  const a = inputA.map(r => Float64Array.from(r));
  const b = inputB.map(r => Float64Array.from(r));
  const m = a.length;
  const p = a[0].length;
  const rhs = b[0].length;
  const tolerance = 1e-9 * Math.sqrt(m);

  if (m < p) throw new Error('Unterbestimmtes Ausgleichungssystem.');

  for (let k = 0; k < p; k++) {
    let norm2 = 0;
    for (let i = k; i < m; i++) norm2 += a[i][k] * a[i][k];

    const norm = Math.sqrt(norm2);

    if (!Number.isFinite(norm) || norm < tolerance) {
      throw new Error(
        'Numerisch nicht trennbare Modellspalten. Datenabdeckung prüfen.'
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

/* ============================================================
 * Fortsetzbare Modellanpassung
 *
 * Je Modell vier Schritte:
 *   TRAIN_FIRST, TRAIN_SECOND, FINAL_FIRST, FINAL_SECOND.
 *
 * Testdaten: zeitlich letzte 20 % der Transitspanne.
 * Die Testbeobachtungen werden nicht anhand des Testfehlers
 * nachträglich bereinigt. Sturmbeeinflusste QC-gültige Werte
 * bleiben in den Testkennzahlen enthalten.
 * ============================================================ */

function hhSaveWork_(ss, value) {
  hhWrite_(ss.getSheetByName('Arbeitsmodell'), 2, [
    ['Arbeitsmodell', JSON.stringify(value)]
  ]);
}

function hhLoadWork_(ss, s, curve) {
  const text = ss.getSheetByName('Arbeitsmodell').getRange('B2').getValue();
  if (!text) throw new Error('Vorläufiges Modell fehlt.');

  const work = JSON.parse(text);

  if (work.k !== s.fitK || work.curve !== curve) {
    throw new Error('Vorläufiges Modell gehört zu einem anderen Arbeitsschritt.');
  }

  return work;
}

function hhFitStep_(ss, s, curve) {
  const rows = curve
    ? hhCurveRows_(ss, s)
    : hhPeakRows_(ss, s.fitK);

  if (rows.length < 200) {
    throw new Error(
      'Zu wenige Daten für ' + (curve ? 'Ganglinie ' : 'Scheitelklasse ') +
      s.fitK
    );
  }

  const cutoff = rows[0].n +
    0.8 * (rows[rows.length - 1].n - rows[0].n);

  const train = rows.filter(r => r.n <= cutoff);
  const test = rows.filter(r => r.n > cutoff);

  switch (s.fitPhase) {
    case 'TRAIN_FIRST': {
      const work = {
        k: s.fitK,
        curve: curve,
        validation: { n: 0, rmse: [], bias: [], terms: null }
      };

      if (train.length >= 200 && test.length >= 40) {
        work.first = hhFirstFit_(train);
        s.fitPhase = 'TRAIN_SECOND';
      } else {
        s.fitPhase = 'FINAL_FIRST';
      }

      hhSaveWork_(ss, work);
      return;
    }

    case 'TRAIN_SECOND': {
      const work = hhLoadWork_(ss, s, curve);
      const fit = hhSecondFit_(train, work.first);
      const errors = fit.coefficients.map((c, d) =>
        test.map(r => r.y[d] - hhEvaluate_(r.n, fit.terms, c))
      );

      work.validation = {
        n: test.length,
        rmse: errors.map(hhRMSE_),
        bias: errors.map(e => hhStats_(e).mean),
        terms: fit.terms.length
      };

      // Erhalten lassen: bei Wiederholung nach Timeout wird
      // TRAIN_SECOND mit demselben ersten Fit erneut ausführbar.
      hhSaveWork_(ss, work);
      s.fitPhase = 'FINAL_FIRST';
      return;
    }

    case 'FINAL_FIRST': {
      const work = hhLoadWork_(ss, s, curve);
      work.finalFirst = hhFirstFit_(rows);
      hhSaveWork_(ss, work);
      s.fitPhase = 'FINAL_SECOND';
      return;
    }

    case 'FINAL_SECOND': {
      const work = hhLoadWork_(ss, s, curve);
      const fit = hhSecondFit_(rows, work.finalFirst);

      if (curve) {
        hhSaveCurveFit_(ss, s, rows, fit, work.validation);
      } else {
        hhSavePeakFit_(ss, s, rows, fit, work.validation);
      }

      s.fitK++;
      s.fitPhase = 'TRAIN_FIRST';

      if (!curve && s.fitK > 4) {
        s.stage = 'CURVE_INIT';
      } else if (curve && s.fitK > s.curve.points) {
        s.curve.complete = true;
        s.curve.finishedUTC = new Date().toISOString();
        hhWriteCurveMeta_(ss, s.curve);
        s.stage = 'DONE';

        hhWrite_(ss.getSheetByName('Info'), 24, [
          ['Analyse fertig UTC', s.curve.finishedUTC],
          ['Validierung', 'Diagnostik und Ganglinie_Diagnostik prüfen.'],
          ['Testdefinition', 'Zeitlich spätere 20 %, ohne Residuen-Clipping.'],
          ['Methodischer Hinweis',
            '39-Glieder-Satz für HW/NW; Ganglinienerweiterung nach BSH 50/2013.'],
          ['Einschränkung',
            'Keine Vorhersage aktueller meteorologischer/hydrologischer Einflüsse.']
        ]);
      }

      return;
    }

    default:
      throw new Error('Unbekannte Fit-Stufe.');
  }
}

function hhCommonModel_(s, fit) {
  return {
    version: HH.VERSION,
    station: HH.EXPECTED_SITE,
    siteCode: HH.EXPECTED_CODE,
    unit: 'm',
    datum: s.header.datum,
    t0: HH.T0,
    syncMinutes: HH.SYNC_MINUTES,
    moonDayHours: HH.MOON_DAY_HOURS,
    terms: fit.terms,
    nMin: fit.nMin,
    nMax: fit.nMax,
    usedCount: fit.usedCount
  };
}

function hhSavePeakFit_(ss, s, rows, fit, validation) {
  const model = Object.assign(hhCommonModel_(s, fit), {
    kind: 'HDDU_PEAK',
    basis: 'MEAN_UPPER_TRANSIT_2013',
    k: s.fitK,
    time: fit.coefficients[0],
    height: fit.coefficients[1],
    inputStartUTC: hhIso_(rows[0].time),
    inputEndUTC: hhIso_(rows[rows.length - 1].time),
    availableCount: rows.length,
    trainingTimeRMSEmin: fit.rmse[0] * 60,
    trainingHeightRMSE: fit.rmse[1],
    validation: {
      n: validation.n,
      timeRMSEmin: validation.n ? validation.rmse[0] * 60 : null,
      heightRMSE: validation.n ? validation.rmse[1] : null,
      timeBiasMin: validation.n ? validation.bias[0] * 60 : null,
      heightBias: validation.n ? validation.bias[1] : null,
      terms: validation.terms
    }
  });

  hhWrite_(ss.getSheetByName('Modell'), s.fitK + 1, [
    [s.fitK, JSON.stringify(model)]
  ]);

  const v = model.validation;

  hhWrite_(ss.getSheetByName('Diagnostik'), s.fitK + 1, [[
    s.fitK,
    rows.length,
    fit.usedCount,
    fit.terms.length,
    model.trainingTimeRMSEmin,
    model.trainingHeightRMSE,
    v.n,
    v.timeRMSEmin === null ? '' : v.timeRMSEmin,
    v.heightRMSE === null ? '' : v.heightRMSE,
    v.timeBiasMin === null ? '' : v.timeBiasMin,
    v.heightBias === null ? '' : v.heightBias,
    v.terms === null ? '' : v.terms
  ]]);
}

/* ============================================================
 * Ganglinienanalyse
 * ============================================================ */

function hhCurveInit_(ss, s) {
  const points = HH.CURVE_POINTS;
  const step = HH_PERIOD / points;
  const origin = hhMeanUpper_(0) + s.hwLag * HH_HOUR + step / 2;

  const nFirst = Math.floor((s.start - origin) / HH_PERIOD);
  const nLast = Math.floor((s.end - 1 - origin) / HH_PERIOD);

  if (!ss.getSheetByName('Ganglinie_Daten')) {
    const headers = ['Transitnummer_n'];
    for (let k = 1; k <= points; k++) headers.push('Wasserstand_m_k' + k);
    hhNewSheet_(ss, 'Ganglinie_Daten', headers);
  }

  hhResize_(
    ss.getSheetByName('Ganglinie_Daten'),
    nLast - nFirst + 2,
    points + 1
  );

  if (!ss.getSheetByName('Ganglinie_Modell')) {
    hhNewSheet_(ss, 'Ganglinie_Modell', ['k', 'JSON']);
  }
  if (!ss.getSheetByName('Ganglinie_Meta')) {
    hhNewSheet_(ss, 'Ganglinie_Meta', ['Eigenschaft', 'JSON']);
  }
  if (!ss.getSheetByName('Ganglinie_Diagnostik')) {
    hhNewSheet_(ss, 'Ganglinie_Diagnostik', [
      'k', 'Vorhanden', 'Verwendet', 'Glieder',
      'Fit_RMSE_m', 'Test_N', 'Test_RMSE_m', 'Test_Bias_m',
      'Test_Glieder', 'Belegung'
    ]);
  }

  s.curve = {
    version: HH.VERSION,
    complete: false,
    station: HH.EXPECTED_SITE,
    siteCode: HH.EXPECTED_CODE,
    unit: 'm',
    datum: s.header.datum,
    points: points,
    moonDayMs: HH_PERIOD,
    stepMs: step,
    originMs: origin,
    hwLagHours: s.hwLag,
    t0: HH.T0,
    syncMinutes: HH.SYNC_MINUTES,
    moonDayHours: HH.MOON_DAY_HOURS,
    nFirst: nFirst,
    nLast: nLast,
    analysisStartUTC: hhIso_(s.start),
    analysisEndUTCExclusive: hhIso_(s.end),
    interpolation: 'linear',
    sourceStepMinutes: HH.STEP_MINUTES,
    sourceInterpolation:
      'linear only between adjacent valid 10-minute observations',
    sourceQC: HH.ACCEPT_QC,
    sourceUseFlag: 1,
    sourceTimeHandling: 'UTC',
    methodNote:
      'BSH 50/2013 hydrograph grid with the 39-constituent HW/NW set'
  };

  hhWriteCurveMeta_(ss, s.curve);
  s.curveNextN = nFirst;
  s.stage = 'CURVE_SAMPLE';
}

function hhWriteCurveMeta_(ss, meta) {
  hhWrite_(ss.getSheetByName('Ganglinie_Meta'), 2, [
    ['Metadaten', JSON.stringify(meta)]
  ]);
}

function hhCurveTime_(meta, n, k) {
  return meta.originMs + n * meta.moonDayMs + (k - 1) * meta.stepMs;
}

function hhCurveSample_(ss, s) {
  const m = s.curve;
  const firstN = s.curveNextN;
  const lastN = Math.min(m.nLast, firstN + HH.SAMPLE_MOON_DAYS - 1);

  const firstTime = hhCurveTime_(m, firstN, 1);
  const lastTime = hhCurveTime_(m, lastN, m.points);

  const from = Math.max(
    s.start,
    s.start + Math.floor((firstTime - s.start) / HH_STEP) * HH_STEP
  );

  const to = Math.min(
    s.end,
    s.start + (Math.ceil((lastTime - s.start) / HH_STEP) + 1) * HH_STEP
  );

  const values = hhReadGrid_(ss, s, from, to);
  const rows = [];

  for (let n = firstN; n <= lastN; n++) {
    const row = [n];

    for (let k = 1; k <= m.points; k++) {
      const time = hhCurveTime_(m, n, k);

      let height = NaN;
      if (time >= s.start && time < s.end) {
        height = hhInterpolateGrid_(values, from, time);
      }

      row.push(Number.isFinite(height) ? height : '');
    }

    rows.push(row);
  }

  hhWrite_(
    ss.getSheetByName('Ganglinie_Daten'),
    2 + firstN - m.nFirst,
    rows
  );

  s.curveNextN = lastN + 1;

  if (s.curveNextN > m.nLast) {
    s.fitK = 1;
    s.fitPhase = 'TRAIN_FIRST';
    s.stage = 'CURVE_FIT';
  }
}

function hhCurveRows_(ss, s) {
  const count = s.curve.nLast - s.curve.nFirst + 1;

  const values = ss.getSheetByName('Ganglinie_Daten')
    .getRange(2, s.fitK + 1, count, 1).getValues();

  const rows = [];

  values.forEach((r, i) => {
    if (typeof r[0] === 'number' && Number.isFinite(r[0])) {
      rows.push({
        n: s.curve.nFirst + i,
        y: [r[0]]
      });
    }
  });

  return rows;
}

function hhSaveCurveFit_(ss, s, rows, fit, validation) {
  const model = Object.assign(hhCommonModel_(s, fit), {
    kind: 'HDDU_HYDROGRAPH',
    k: s.fitK,
    height: fit.coefficients[0],
    availableCount: rows.length,
    trainingHeightRMSE: fit.rmse[0],
    validation: {
      n: validation.n,
      rmse: validation.n ? validation.rmse[0] : null,
      bias: validation.n ? validation.bias[0] : null,
      terms: validation.terms
    }
  });

  hhWrite_(ss.getSheetByName('Ganglinie_Modell'), s.fitK + 1, [
    [s.fitK, JSON.stringify(model)]
  ]);

  const v = model.validation;

  hhWrite_(ss.getSheetByName('Ganglinie_Diagnostik'), s.fitK + 1, [[
    s.fitK,
    rows.length,
    fit.usedCount,
    fit.terms.length,
    fit.rmse[0],
    v.n,
    v.rmse === null ? '' : v.rmse,
    v.bias === null ? '' : v.bias,
    v.terms === null ? '' : v.terms,
    rows.length / (s.curve.nLast - s.curve.nFirst + 1)
  ]]);
}

/* ============================================================
 * UTC
 * ============================================================ */

function hhParseUTC_(text) {
  if (
    typeof text !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)
  ) {
    throw new Error('UTC-Format erforderlich: YYYY-MM-DDTHH:mm:ssZ');
  }

  const time = Date.parse(text);

  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== text.replace('Z', '.000Z')
  ) {
    throw new Error('Ungültige UTC-Zeit: ' + text);
  }

  return time;
}

function hhIso_(ms) {
  return new Date(Math.round(ms)).toISOString();
}

/* ============================================================
 * Tests
 * ============================================================ */

function hdduTests() {
  function assert(condition, message) {
    if (!condition) throw new Error('Test fehlgeschlagen: ' + message);
  }

  const header = { nullValue: '-99.9999' };

  const a = hhParseGeslaRow_(
    '1999/11/01 00:00:00   0.5260 1 1', header, 'Test'
  );

  assert(
    a.time === Date.parse('1999-11-01T00:00:00Z'),
    'UTC ohne MEZ/MESZ-Verschiebung'
  );
  assert(a.valid && a.level === 0.526, 'Meter unverändert');

  const missing = hhParseGeslaRow_(
    '1999/11/01 00:10:00 -99.9999 5 0', header, 'Test'
  );
  assert(!missing.valid && missing.isNull, 'NULL-Wert');

  const rejectedUse = hhParseGeslaRow_(
    '1999/11/01 00:10:00 1.0 1 0', header, 'Test'
  );
  assert(!rejectedUse.valid, 'Use=0');

  const doubtful = hhParseGeslaRow_(
    '1999/11/01 00:10:00 1.0 3 1', header, 'Test'
  );
  assert(!doubtful.valid, 'QC=3');

  const sourceInterpolated = hhParseGeslaRow_(
    '1999/11/01 00:10:00 1.0 2 1', header, 'Test'
  );
  assert(
    sourceInterpolated.valid === HH.ACCEPT_QC.includes(2),
    'QC=2 gemäß Konfiguration'
  );

  const grid = Float64Array.from([0, 2, NaN, 6]);
  assert(
    hhInterpolateGrid_(grid, 0, HH_STEP / 2) === 1,
    'Interpolation innerhalb gültiger 10 Minuten'
  );
  assert(
    Number.isNaN(hhInterpolateGrid_(grid, 0, 1.5 * HH_STEP)),
    'Keine Interpolation über ungültigen Wert'
  );
  assert(
    hhInterpolateGrid_(grid, 0, 3 * HH_STEP) === 6,
    'Exakter gültiger Rasterwert'
  );

  const solution = hhQR_(
    [[1, 0], [1, 1], [1, 2], [1, 3]],
    [[2], [5], [8], [11]]
  );
  assert(Math.abs(solution[0][0] - 2) < 1e-10, 'QR-Konstante');
  assert(Math.abs(solution[1][0] - 3) < 1e-10, 'QR-Steigung');

  assert(HH_TERMS.length === 39, '39 Glieder');
  assert(new Set(HH_TERMS.map(t => t[0])).size === 39, 'Eindeutige Glieder');

  hhRequireAstronomy_();
  const cache = new Map();

  const references = [
    [2 * 14468, '1991-01-01T00:18:00Z'],
    [2 * 14468 + 1, '1991-01-01T12:50:00Z'],
    [2 * 21172, '2009-12-30T23:12:00Z']
  ];

  const astronomy = references.map(([q, reference]) => {
    const time = hhTrueTransit_(q, cache);
    const difference = (time - Date.parse(reference)) / HH_MINUTE;

    assert(Math.abs(difference) < 2, 'Transitvergleich q=' + q);

    return {
      q: q,
      berechnet: hhIso_(time),
      referenz: reference,
      differenzMinuten: difference
    };
  });

  console.log(JSON.stringify(astronomy, null, 2));
  console.log(
    'Parser-, Einheiten-, QC-, Interpolations-, QR- und Astronomietests bestanden.'
  );

  return true;
}
