/*
Hier ist die vollständige, zusammengeführte Fassung von **`hddu.gs`**. Sie ersetzt die bisherige Datei vollständig; die vorhandene Astronomy-Bibliothek bleibt unverändert im Projekt.

**Start:** `hdduStart()`  
**Fortschritt:** `hdduStatus()`  
**Nach Abschluss:** `beispielWasserstand20261014()` oder `beispielGanglinie20261014()`

Die 39 Glieder entsprechen Tabelle 4 des ab 2020 verwendeten Konstituentensatzes. Die minutengenaue Wasserstandsausgabe beruht auf der zusätzlich analysierten Ganglinie, nicht auf einer bloßen Verbindung von HW und NW. Der Code wurde hier nicht gegen deine Google-Tabellen ausgeführt.

 * hddu.gs
 *
 * HDdU-Arbeitsimplementierung:
 *
 * 1. Gemeinsame Analyse minütlicher Wasserstandsdaten aus vier Quellen.
 * 2. Scheitelpunktanalyse für HW/NW:
 *    vier Ereignisklassen mit jeweils Zeit- und Höhenmodell.
 * 3. Ganglinienanalyse mit standardmäßig 96 Stützstellen
 *    je mittlerem Mondtag.
 * 4. Wasserstandsvorausberechnung für einzelne UTC-Minuten
 *    oder Zeiträume.
 *
 * Grundlagen:
 * - Müller-Navarra: Berichte des BSH 50/2013.
 * - Boesch / Müller-Navarra:
 *   Reassessment of long-period constituents ...
 *   Tabelle 4: 39 Glieder, verwendet ab Gezeitentafeln 2020.
 *
 * Voraussetzung:
 * Astronomy Engine mit globalem Objekt Astronomy ist im
 * selben Apps-Script-Projekt vorhanden.
 *
 * WICHTIG:
 * - Jede Quellenzeile entspricht einer Minute.
 * - Fehlende Messungen müssen als leere/ungültige Werte
 *   erhalten bleiben; Zeilen dürfen nicht entfernt sein.
 * - Alle Quellen müssen denselben Pegel, dieselbe Einheit
 *   und denselben Höhenbezug verwenden.
 * - Keine amtliche Gezeitenvorausberechnung.
 * - Keine Vorhersage von Windstau oder aktuellen Abflüssen.
 * - Minütliche Ausgabe bedeutet nicht eine garantierte
 *   Vorhersagegenauigkeit von einer Minute.
 *
 * Bedienung:
 *   hdduStart()
 *   hdduStatus()
 *   hdduFortsetzen()
 *   hdduStop()
 *
 * Nach vollständiger Analyse:
 *   beispielWasserstand20261014()
 *   beispielGanglinie20261014()
 *   beispiel20261103()
 *
 * Während einer laufenden Analyse weder Quellen noch
 * Konfiguration verändern.
 */

// ============================================================
// Konfiguration
// ============================================================

const HD = {
  FIRST_ROW: 2,
  LEVEL_COLUMN: 2,

  // Gemeinsamer Nullpunkt aller absoluten Minutenindizes.
  FIRST_UTC: Date.parse('2006-12-31T23:00:00Z'),

  // BSH 50/2013, Abschnitt 4b.
  // Nicht die abweichende Angabe im Formelzeichenverzeichnis.
  T0: Date.UTC(1949, 11, 31, 21, 8, 0),
  SYNC_MINUTES: 24.23,
  MOON_DAY_H: 2 * 12.4206012,

  // Verarbeitung je Triggeraufruf.
  READ_BLOCK: 60000,
  ASSIGN_BLOCK: 350,

  // Scheitelpunkterkennung.
  SMOOTH_HALF: 5,
  EXTREME_HALF: 120,
  MAX_PLATEAU_MIN: 60,

  /*
   * Nur zur Auswahl des Intervallzweiges.
   * Das eigentliche mittlere HW-Intervall wird geschätzt.
   */
  HW_LAG_BRANCH_H: 12,

  MAX_ASSIGN_ERROR_H: 2.5,

  // Bekannte Fehlwertcodes ergänzen, z. B. [-9999].
  INVALID_LEVELS: [],

  STATE_KEY: 'HDDU_STATE_V2',
  RESULT_KEY: 'HDDU_RESULT_ID_V2'
};

const HD_SOURCES = [
  {
    label: '2007–2010',
    id: '14Ql60iWtxUY8EIhuk02V1lnIMftE-Lk1rwrr9ZKGchs',
    gid: 427788521,
    firstUTC: '2006-12-31T23:00:00Z',
    endUTC: '2010-12-31T23:00:00Z'
  },
  {
    label: '2011–2015',
    id: '1GakH1s_9dWA7X2C-d1hCeD783cknmSfDr_7M6rgmDnc',
    gid: 1060632291,
    firstUTC: '2010-12-31T23:00:00Z',
    endUTC: '2015-12-31T23:00:00Z'
  },
  {
    label: '2016–2020',
    id: '16tQKio7li1lY-L2V-z5gUwEzVTRXGpVUjMu0S1MTfqA',
    gid: 1052791657,
    firstUTC: '2015-12-31T23:00:00Z',
    endUTC: '2020-12-31T23:00:00Z'
  },
  {
    label: '2021–2025',
    id: '1kqTroUHmCJg3XNfZ9bRHytdfreT48tO92b6j3YopkAU',
    gid: 1745058152,
    firstUTC: '2020-12-31T23:00:00Z',
    endUTC: '2025-12-31T23:00:00Z'
  }
];

const HD_CURVE = {
  /*
   * 96: Raster entsprechend BSH 50/2013.
   * 288: dichteres Raster, mehr Rechenzeit und Speicher.
   * Nur vor einer neuen Analyse ändern.
   */
  POINTS: 96,

  // Mondtage je Leselauf der Ganglinienaufbereitung.
  SAMPLE_DAYS: 20,

  // Schutz gegen übergroße synchrone Ausgabeaufrufe.
  MAX_OUTPUT_ROWS: 100000
};

const HOUR = 3600000;
const MINUTE = 60000;
const DAY = 86400000;
const RAD = Math.PI / 180;

/*
 * Doodson, Grad/Transitnummer, Rang.
 *
 * Genau die 39 Glieder aus Tabelle 4 des Aufsatzes
 * von Boesch / Müller-Navarra.
 *
 * Die Frequenzen werden unmittelbar aus Tabelle 4 verwendet.
 * Keine Rekonstruktion aus den Argumentzahlen anderer Tabellen.
 */
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

// ============================================================
// Start, Status, Fortsetzen und Hintergrundverarbeitung
// ============================================================

/**
 * Startet Scheitelpunkt- und Ganglinienanalyse.
 *
 * Ohne Argumente:
 * [2006-12-31T23:00Z, 2025-12-31T23:00Z)
 *
 * Beispiel:
 * hdduStart(
 *   '2010-01-01 0000Z',
 *   '2025-12-31 2300Z'
 * );
 *
 * Das Ende ist exklusiv.
 */
function hdduStart(vonUTC, bisUTC) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    requireAstronomy_();

    const old = loadState_();

    if (old && old.stage !== 'DONE') {
      throw new Error(
        'Eine Analyse existiert bereits. ' +
        'Mit hdduFortsetzen() fortsetzen oder mit hdduStop() verwerfen.'
      );
    }

    if (HD_TERMS.length !== 39) {
      throw new Error('Erwartet werden die 39 Glieder aus Tabelle 4.');
    }

    if (
      !Number.isInteger(HD_CURVE.POINTS) ||
      HD_CURVE.POINTS < 96 ||
      HD_CURVE.POINTS > 288
    ) {
      throw new Error(
        'HD_CURVE.POINTS muss eine ganze Zahl zwischen 96 und 288 sein.'
      );
    }

    if (
      !Number.isInteger(HD_CURVE.SAMPLE_DAYS) ||
      HD_CURVE.SAMPLE_DAYS < 1
    ) {
      throw new Error('HD_CURVE.SAMPLE_DAYS muss positiv und ganzzahlig sein.');
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
      end <= start
    ) {
      throw new Error(
        'Analysezeitraum liegt außerhalb der Quellen oder ist ungültig.'
      );
    }

    const begin = (start - HD.FIRST_UTC) / MINUTE;
    const count = (end - HD.FIRST_UTC) / MINUTE;

    if (
      !Number.isInteger(begin) ||
      !Number.isInteger(count) ||
      count - begin < 10000
    ) {
      throw new Error(
        'Analysezeitraum zu kurz oder nicht minutengerastert.'
      );
    }

    removeTriggers_();

    const sources = buildSourceManifest_();

    const out = SpreadsheetApp.create(
      'HDdU 39 Glieder ' +
      Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH:mm')
    );

    out.setSpreadsheetTimeZone('Etc/UTC');

    const info = out.getSheets()[0];
    info.setName('Info');

    const infoRows = [
      ['Eigenschaft', 'Wert'],
      ['Verfahren', 'HDdU: Scheitelpunkte und Ganglinie'],
      ['Analysebeginn UTC', iso_(start)],
      ['Analyseende UTC, exklusiv', iso_(end)],
      ['Zeitschritt der Quellen', '1 Minute je Zeile, auch bei Leerwerten'],
      ['Status', 'EXTRACT'],
      ['Konstituentenkandidaten', HD_TERMS.length],
      ['Ganglinien-Stützstellen je Mondtag', HD_CURVE.POINTS],
      ['Höhenbezug', 'Originaleinheit und Original-Höhendatum der Quellen'],
      [
        'Voraussetzung',
        'Alle Quellen gehören zum selben Pegel und haben denselben Höhenbezug.'
      ]
    ];

    info.getRange(1, 1, infoRows.length, 2).setValues(infoRows);
    info.setFrozenRows(1);

    const sourceInfo = createSheet_(out, 'Quellen', [
      'Zeitraum',
      'Spreadsheet_ID',
      'GID',
      'B2_UTC',
      'Ende_UTC_exklusiv',
      'Soll_Minuten',
      'Vorhandene_Zeilen',
      'Verwendbare_Zeilen',
      'Fehlende_Endzeilen',
      'Zusatzzeilen'
    ]);

    appendRows_(sourceInfo, sources.map(s => [
      s.label,
      s.id,
      s.gid,
      s.firstUTC,
      s.endUTC,
      s.capacity,
      s.actual,
      s.available,
      Math.max(0, s.capacity - s.actual),
      Math.max(0, s.actual - s.capacity)
    ]));

    createSheet_(out, 'Extrema', [
      'UTC_ms',
      'Art',
      'Wasserstand'
    ]);

    createSheet_(out, 'Zuordnung', [
      'Halbtransit_q',
      'Transitnummer_n',
      'k',
      'Intervall_zum_mittleren_oberen_Transit_h',
      'Wasserstand',
      'Ereignis_UTC_ms',
      'Wahrer_Transit_UTC_ms',
      'Zuordnungsfehler_h'
    ]);

    createSheet_(out, 'Modell', [
      'k',
      'JSON'
    ]);

    createSheet_(out, 'Koeffizienten', [
      'k',
      'Groesse',
      'Doodson',
      'Grad_pro_Transit',
      'Cos_Koeff',
      'Sin_Koeff',
      'Amplitude',
      'Phase_Grad'
    ]);

    createSheet_(out, 'Diagnostik', [
      'k',
      'Zugeordnet',
      'Verwendet',
      'Glieder',
      'Anpassungs_RMSE_Zeit_min',
      'Anpassungs_RMSE_Hoehe_Originaleinheit',
      'Test_N',
      'Test_RMSE_Zeit_min',
      'Test_RMSE_Hoehe_Originaleinheit',
      'Test_Glieder'
    ]);

    const state = {
      version: 2,
      stage: 'EXTRACT',
      outputId: out.getId(),

      // Absolute Minutenindizes relativ zu HD.FIRST_UTC.
      begin: begin,
      count: count,
      next: begin,

      analysisStart: start,
      analysisEnd: end,
      sources: sources,
      curvePoints: HD_CURVE.POINTS,
      createdUTC: iso_(Date.now())
    };

    rememberAppendRows_(state, out);
    saveState_(state);

    PropertiesService.getScriptProperties()
      .setProperty(HD.RESULT_KEY, out.getId());

    ScriptApp.newTrigger('hdduWeiter')
      .timeBased()
      .everyMinutes(1)
      .create();

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

    if (state.version !== 2) {
      throw new Error(
        'Unpassender Arbeitszustand. Analyse neu starten.'
      );
    }

    const out = SpreadsheetApp.openById(state.outputId);

    /*
     * Entfernt unbestätigte Anhänge eines abgebrochenen Laufs.
     * Gangliniendaten und Modelle werden an feste Zeilen geschrieben
     * und sind bei Wiederholung überschreibbar.
     */
    restoreAppendRows_(state, out);

    switch (state.stage) {
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
        throw new Error(
          'Unbekannter Arbeitszustand: ' + state.stage
        );
    }

    delete state.lastError;

    SpreadsheetApp.flush();
    rememberAppendRows_(state, out);
    saveState_(state);

    out.getSheetByName('Info')
      .getRange('B6')
      .setValue(state.stage);

    if (state.stage === 'DONE') {
      removeTriggers_();
      console.log(
        'Gesamte Analyse fertig: ' + out.getUrl()
      );
    }

  } catch (error) {
    removeTriggers_();

    // Nur den zuletzt bestätigten Zustand um die Fehlermeldung ergänzen.
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

/**
 * Nach behobenem Fehler oder nach Quotenreset ausführen.
 */
function hdduFortsetzen() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const state = loadState_();

    if (!state || state.stage === 'DONE') {
      throw new Error(
        'Keine unvollständige Analyse vorhanden.'
      );
    }

    delete state.lastError;
    saveState_(state);

    removeTriggers_();

    ScriptApp.newTrigger('hdduWeiter')
      .timeBased()
      .everyMinutes(1)
      .create();

    console.log(
      'Fortsetzung aktiviert. Aktuelle Stufe: ' + state.stage
    );

  } finally {
    lock.releaseLock();
  }
}

function hdduStatus() {
  const state = loadState_();
  console.log(JSON.stringify(state, null, 2));

  if (state) {
    console.log(
      'https://docs.google.com/spreadsheets/d/' +
      state.outputId
    );
  }

  return state;
}

function hdduStop() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    removeTriggers_();

    /*
     * Ergebnisdateien bleiben erhalten.
     * Der Arbeitszustand wird verworfen.
     */
    PropertiesService.getScriptProperties()
      .deleteProperty(HD.STATE_KEY);

    console.log(
      'Analyse gestoppt. Bereits erzeugte Ergebnisdateien bleiben erhalten.'
    );

  } finally {
    lock.releaseLock();
  }
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'hdduWeiter') {
      ScriptApp.deleteTrigger(trigger);
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
    .setProperty(
      HD.STATE_KEY,
      JSON.stringify(state)
    );
}

function rememberAppendRows_(state, out) {
  const names = [
    'Info',
    'Extrema',
    'Zuordnung',
    'Koeffizienten',
    'Diagnostik'
  ];

  state.committedRows = {};

  for (const name of names) {
    const sheet = out.getSheetByName(name);

    if (sheet) {
      state.committedRows[name] = sheet.getLastRow();
    }
  }
}

function restoreAppendRows_(state, out) {
  if (!state.committedRows) return;

  for (const name of Object.keys(state.committedRows)) {
    const sheet = out.getSheetByName(name);
    if (!sheet) continue;

    const committed = state.committedRows[name];
    const actual = sheet.getLastRow();

    if (actual > committed) {
      sheet.getRange(
        committed + 1,
        1,
        actual - committed,
        sheet.getMaxColumns()
      ).clearContent();
    }
  }
}

// ============================================================
// Tabellen und Quellenzugriff
// ============================================================

function sourceSheet_(source) {
  if (!source) {
    throw new Error('Quellendefinition fehlt.');
  }

  const ss = SpreadsheetApp.openById(source.id);
  const sheet = ss.getSheets()
    .find(s => s.getSheetId() === source.gid);

  if (!sheet) {
    throw new Error(
      'Quellblatt nicht gefunden: ' +
      source.label +
      ', GID ' +
      source.gid
    );
  }

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
      end <= start
    ) {
      throw new Error('Ungültige Quellengrenzen.');
    }

    if (
      previousEnd !== null &&
      start !== previousEnd
    ) {
      throw new Error(
        'Quellenintervalle sind nicht lückenlos definiert.'
      );
    }

    previousEnd = end;

    const offset =
      (start - HD.FIRST_UTC) / MINUTE;

    const capacity =
      (end - start) / MINUTE;

    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(capacity)
    ) {
      throw new Error(
        'Quellenzeiten liegen nicht im Minutenraster.'
      );
    }

    const sheet = sourceSheet_(source);

    const actual = Math.max(
      0,
      sheet.getLastRow() - HD.FIRST_ROW + 1
    );

    /*
     * Zusatzzeilen hinter der nominalen Zeitgrenze werden
     * dokumentiert, aber nicht der nächsten Quelle zugeschlagen.
     *
     * Fehlende Endzeilen bleiben zeitlich fehlend.
     */
    return Object.assign({}, source, {
      offset: offset,
      capacity: capacity,
      actual: actual,
      available: Math.min(actual, capacity)
    });
  });
}

function ensureSheetSize_(sheet, rows, columns) {
  if (rows > sheet.getMaxRows()) {
    sheet.insertRowsAfter(
      sheet.getMaxRows(),
      rows - sheet.getMaxRows()
    );
  }

  if (columns > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      columns - sheet.getMaxColumns()
    );
  }
}

function createSheet_(ss, name, headers) {
  const sheet = ss.insertSheet(name);

  ensureSheetSize_(sheet, 2, headers.length);

  // Überflüssige Spalten reduzieren den verfügbaren Zellenvorrat.
  if (sheet.getMaxColumns() > headers.length) {
    sheet.deleteColumns(
      headers.length + 1,
      sheet.getMaxColumns() - headers.length
    );
  }

  sheet.getRange(
    1, 1, 1, headers.length
  ).setValues([headers]);

  sheet.setFrozenRows(1);
  return sheet;
}

function appendRows_(sheet, rows) {
  if (!rows.length) return;

  const first = sheet.getLastRow() + 1;
  const needed = first + rows.length - 1;

  ensureSheetSize_(
    sheet,
    needed,
    rows[0].length
  );

  sheet.getRange(
    first,
    1,
    rows.length,
    rows[0].length
  ).setValues(rows);
}

/**
 * Liest [first, last) in absoluten Minutenindizes.
 * Fehlende Daten bleiben NaN.
 *
 * Es werden nur Zeilen gelesen, die tatsächlich vorhanden
 * und dem jeweiligen nominalen Quellenintervall zugeordnet sind.
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

  for (const source of state.sources) {
    const left = Math.max(
      first,
      source.offset
    );

    const right = Math.min(
      last,
      source.offset + source.available
    );

    if (right <= left) continue;

    const values = sourceSheet_(source)
      .getRange(
        HD.FIRST_ROW + left - source.offset,
        HD.LEVEL_COLUMN,
        right - left,
        1
      )
      .getValues();

    for (let i = 0; i < values.length; i++) {
      result[left - first + i] =
        numericLevel_(values[i][0]);
    }
  }

  return result;
}

// ============================================================
// Messwertkonvertierung und Scheitelpunkterkennung
// ============================================================

function numericLevel_(value) {
  if (value === '' || value === null) {
    return NaN;
  }

  let x;

  if (typeof value === 'number') {
    x = value;

  } else if (typeof value === 'string') {
    // Dezimalkomma erlaubt, Tausendertrennzeichen nicht.
    const text = value.trim().replace(',', '.');

    if (
      !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)
    ) {
      return NaN;
    }

    x = Number(text);

  } else {
    return NaN;
  }

  if (!Number.isFinite(x)) return NaN;
  if (HD.INVALID_LEVELS.includes(x)) return NaN;

  return x;
}

function extractBlock_(state, out) {
  const coreStart = state.next;

  const coreEnd = Math.min(
    state.count,
    coreStart + HD.READ_BLOCK
  );

  const margin =
    HD.EXTREME_HALF +
    HD.SMOOTH_HALF +
    HD.MAX_PLATEAU_MIN +
    10;

  const readStart = Math.max(
    state.begin,
    coreStart - margin
  );

  const readEnd = Math.min(
    state.count,
    coreEnd + margin
  );

  const values = readMinuteRange_(
    state,
    readStart,
    readEnd
  );

  const smooth = smoothComplete_(
    values,
    HD.SMOOTH_HALF
  );

  const maxima = rollingExtreme_(
    smooth,
    HD.EXTREME_HALF,
    true
  );

  const minima = rollingExtreme_(
    smooth,
    HD.EXTREME_HALF,
    false
  );

  const result = collectPeaks_(
    smooth,
    maxima,
    true,
    readStart,
    coreStart,
    coreEnd
  ).concat(
    collectPeaks_(
      smooth,
      minima,
      false,
      readStart,
      coreStart,
      coreEnd
    )
  );

  result.sort((a, b) => a[0] - b[0]);

  appendRows_(
    out.getSheetByName('Extrema'),
    result
  );

  state.next = coreEnd;

  if (coreEnd >= state.count) {
    state.stage = 'ESTIMATE';
  }
}

/*
 * Zentrierte Glättung.
 * Unvollständige Fenster bleiben ungültig.
 */
function smoothComplete_(a, half) {
  const n = a.length;

  const sum = new Float64Array(n + 1);
  const count = new Int32Array(n + 1);

  for (let i = 0; i < n; i++) {
    const valid = Number.isFinite(a[i]);

    sum[i + 1] =
      sum[i] + (valid ? a[i] : 0);

    count[i + 1] =
      count[i] + (valid ? 1 : 0);
  }

  const result = new Float64Array(n);
  result.fill(NaN);

  const width = 2 * half + 1;

  for (let i = half; i < n - half; i++) {
    const left = i - half;
    const right = i + half + 1;

    if (
      count[right] - count[left] === width
    ) {
      result[i] =
        (sum[right] - sum[left]) / width;
    }
  }

  return result;
}

/*
 * Laufendes Maximum/Minimum mit monotoner Warteschlange.
 */
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

    if (
      leaving >= 0 &&
      Number.isFinite(a[leaving])
    ) {
      validCount--;
    }

    while (
      head < tail &&
      queue[head] <= leaving
    ) {
      head++;
    }

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

    if (
      right >= width - 1 &&
      validCount === width
    ) {
      result[right - half] = a[queue[head]];
    }
  }

  return result;
}

function collectPeaks_(
  a,
  extreme,
  maximum,
  readStart,
  coreStart,
  coreEnd
) {
  const rows = [];
  const w = HD.EXTREME_HALF;

  for (let i = w; i < a.length - w; i++) {
    if (
      !Number.isFinite(extreme[i]) ||
      a[i] !== extreme[i]
    ) {
      continue;
    }

    const start = i;

    while (
      i + 1 < a.length - w &&
      Number.isFinite(extreme[i + 1]) &&
      a[i + 1] === extreme[i + 1]
    ) {
      i++;
    }

    const end = i;

    if (
      end - start + 1 > HD.MAX_PLATEAU_MIN
    ) {
      continue;
    }

    const centre =
      Math.floor((start + end) / 2);

    const globalIndex =
      readStart + centre;

    if (
      globalIndex < coreStart ||
      globalIndex >= coreEnd
    ) {
      continue;
    }

    const goodFlanks = maximum
      ? (
        a[centre] > a[centre - w] &&
        a[centre] > a[centre + w]
      )
      : (
        a[centre] < a[centre - w] &&
        a[centre] < a[centre + w]
      );

    if (!goodFlanks) continue;

    let offset =
      (start + end) / 2 - centre;

    let level = a[centre];

    // Lokale Parabelverfeinerung bei Einzelmaximum/-minimum.
    if (start === end) {
      const d = 5;

      const left = a[centre - d];
      const right = a[centre + d];

      const curvature =
        left - 2 * level + right;

      if (
        Number.isFinite(curvature) &&
        curvature !== 0 &&
        (maximum ? curvature < 0 : curvature > 0)
      ) {
        const candidate =
          d * (left - right) / (2 * curvature);

        if (Math.abs(candidate) <= d) {
          offset = candidate;

          level -=
            (right - left) * (right - left) /
            (8 * curvature);
        }
      }
    }

    rows.push([
      HD.FIRST_UTC +
        (globalIndex + offset) * MINUTE,
      maximum ? 'HW' : 'NW',
      level
    ]);
  }

  return rows;
}

// ============================================================
// Mittlerer Mond und wahre Mondtransite
// ============================================================

function meanUpper_(n) {
  return HD.T0 +
    HD.SYNC_MINUTES * MINUTE +
    n * HD.MOON_DAY_H * HOUR;
}

function meanHalf_(q) {
  return meanUpper_(0) +
    q * HD.MOON_DAY_H * HOUR / 2;
}

function requireAstronomy_() {
  const required = [
    'AstroTime',
    'GeoMoon',
    'Rotation_EQJ_EQD',
    'RotateVector',
    'EquatorFromVector',
    'SiderealTime'
  ];

  if (typeof Astronomy === 'undefined') {
    throw new Error(
      'Astronomy Engine fehlt. ' +
      'Browser-Build mit globalem Objekt Astronomy bereitstellen.'
    );
  }

  for (const name of required) {
    if (typeof Astronomy[name] !== 'function') {
      throw new Error(
        'Astronomy-Funktion fehlt: ' + name
      );
    }
  }
}

function wrap180_(x) {
  return ((x + 180) % 360 + 360) % 360 - 180;
}

/*
 * Geozentrischer scheinbarer Stundenwinkel in Greenwich.
 * RA und Sternzeit beziehen sich auf das Datum.
 */
function moonHourAngle_(ms) {
  const time =
    new Astronomy.AstroTime(new Date(ms));

  const eqj =
    Astronomy.GeoMoon(time);

  const rotation =
    Astronomy.Rotation_EQJ_EQD(time);

  const eqd =
    Astronomy.RotateVector(rotation, eqj);

  const equatorial =
    Astronomy.EquatorFromVector(eqd);

  return wrap180_(
    15 * (
      Astronomy.SiderealTime(time) -
      equatorial.ra
    )
  );
}

/*
 * q = 2*n     : oberer Transit
 * q = 2*n + 1 : nachfolgender unterer Transit
 */
function trueTransit_(q, cache) {
  const key = String(q);

  if (
    cache &&
    Object.prototype.hasOwnProperty.call(cache, key)
  ) {
    return cache[key];
  }

  const lower = ((q % 2) + 2) % 2;
  const target = lower ? 180 : 0;

  let time = meanHalf_(q);

  for (let iteration = 0; iteration < 10; iteration++) {
    const error = wrap180_(
      moonHourAngle_(time) - target
    );

    const delta = 5 * MINUTE;

    const speed = wrap180_(
      moonHourAngle_(time + delta) -
      moonHourAngle_(time - delta)
    ) / (2 * delta / HOUR);

    if (!(speed > 10 && speed < 20)) {
      throw new Error(
        'Unplausible Mond-Stundenwinkelgeschwindigkeit.'
      );
    }

    const correction =
      error / speed * HOUR;

    time -= correction;

    if (Math.abs(correction) < 100) {
      break;
    }
  }

  const residual = Math.abs(
    wrap180_(
      moonHourAngle_(time) - target
    )
  );

  if (
    residual > 0.001 ||
    Math.abs(time - meanHalf_(q)) > 4 * HOUR
  ) {
    throw new Error(
      'Mondtransit nicht sicher bestimmt, q=' + q
    );
  }

  if (cache) cache[key] = time;
  return time;
}

// ============================================================
// Schätzung der Intervallzweige und Ereigniszuordnung
// ============================================================

function estimateLags_(state, out) {
  const sheet = out.getSheetByName('Extrema');
  const count = sheet.getLastRow() - 1;

  if (count < 200) {
    throw new Error(
      'Zu wenige erkannte Scheitelpunkte.'
    );
  }

  const rows = sheet
    .getRange(2, 1, count, 3)
    .getValues();

  const highs = rows.filter(r => r[1] === 'HW');
  const lows = rows.filter(r => r[1] === 'NW');

  const hw = circularLag_(
    highs,
    HD.HW_LAG_BRANCH_H
  );

  const nw = circularLag_(
    lows,
    hw.lag + HD.MOON_DAY_H / 4
  );

  if (
    hw.coherence < 0.5 ||
    nw.coherence < 0.5
  ) {
    throw new Error(
      'Keine ausreichend eindeutige halbtägige Scheitelpunktfolge. ' +
      'Daten, Fehlwerte und Erkennungsparameter prüfen.'
    );
  }

  const ebb = nw.lag - hw.lag;

  if (!(ebb > 2 && ebb < 11)) {
    throw new Error(
      'Unplausibler Abstand HW → NW: ' +
      ebb + ' Stunden.'
    );
  }

  state.hwLag = hw.lag;
  state.nwLag = nw.lag;
  state.extremaCount = count;
  state.nextEvent = 0;
  state.stage = 'ASSIGN';

  appendRows_(
    out.getSheetByName('Info'),
    [
      ['Geschätztes HW-Intervall h', hw.lag],
      ['Geschätztes NW-Intervall h', nw.lag],
      ['HW Phasenkohärenz', hw.coherence],
      ['NW Phasenkohärenz', nw.coherence]
    ]
  );
}

function circularLag_(rows, branchCentre) {
  const halfH = HD.MOON_DAY_H / 2;

  let cosine = 0;
  let sine = 0;

  for (const row of rows) {
    const hours =
      (Number(row[0]) - meanUpper_(0)) / HOUR;

    const angle =
      2 * Math.PI * hours / halfH;

    cosine += Math.cos(angle);
    sine += Math.sin(angle);
  }

  let lag =
    Math.atan2(sine, cosine) *
    halfH / (2 * Math.PI);

  lag +=
    Math.round((branchCentre - lag) / halfH) *
    halfH;

  return {
    lag: lag,
    coherence:
      Math.hypot(cosine, sine) /
      Math.max(1, rows.length)
  };
}

function assignBlock_(state, out) {
  const size = Math.min(
    HD.ASSIGN_BLOCK,
    state.extremaCount - state.nextEvent
  );

  const rows = out.getSheetByName('Extrema')
    .getRange(
      2 + state.nextEvent,
      1,
      size,
      3
    )
    .getValues();

  const cache = {};
  const assigned = [];

  const halfMs =
    HD.MOON_DAY_H * HOUR / 2;

  for (const row of rows) {
    const time = Number(row[0]);
    const high = row[1] === 'HW';

    const lag = high
      ? state.hwLag
      : state.nwLag;

    const initialQ = Math.round(
      (
        time -
        meanUpper_(0) -
        lag * HOUR
      ) / halfMs
    );

    let best = null;

    for (
      let q = initialQ - 1;
      q <= initialQ + 1;
      q++
    ) {
      const transit = trueTransit_(q, cache);

      const error = Math.abs(
        (time - transit) / HOUR - lag
      );

      if (!best || error < best.error) {
        best = {
          q: q,
          transit: transit,
          error: error
        };
      }
    }

    if (
      best.error > HD.MAX_ASSIGN_ERROR_H
    ) {
      continue;
    }

    const n = Math.floor(best.q / 2);
    const lower = best.q - 2 * n;

    const k =
      1 + 2 * lower + (high ? 0 : 1);

    assigned.push([
      best.q,
      n,
      k,
      (time - meanUpper_(n)) / HOUR,
      Number(row[2]),
      time,
      best.transit,
      best.error
    ]);
  }

  appendRows_(
    out.getSheetByName('Zuordnung'),
    assigned
  );

  state.nextEvent += size;

  if (
    state.nextEvent >= state.extremaCount
  ) {
    state.stage = 'FIT';
    state.nextK = 1;
  }
}

// ============================================================
// Konstituentenauswahl, Statistik und Ausgleichung
// ============================================================

function transitBounds_(rows) {
  let min = Infinity;
  let max = -Infinity;

  for (const row of rows) {
    min = Math.min(min, row.n);
    max = Math.max(max, row.n);
  }

  return { min: min, max: max };
}

/*
 * Rangbasierte Auswahl aus den 39 Gliedern.
 *
 * Auflösungskriterium:
 *   resolution = 360 / Transitspanne
 *
 * Auch die Trennbarkeit vom konstanten Glied wird geprüft.
 */
function selectTerms_(rows) {
  const bounds = transitBounds_(rows);
  const span = bounds.max - bounds.min;

  if (!(span > 60)) {
    throw new Error(
      'Zu kurze Zeitspanne für die HDdU-Ausgleichung.'
    );
  }

  const resolution = 360 / span;
  const selected = [];

  const ranked = HD_TERMS.slice()
    .sort((a, b) => a[2] - b[2]);

  for (const term of ranked) {
    if (term[1] < resolution) {
      continue;
    }

    if (
      selected.every(other =>
        Math.abs(term[1] - other[1]) >= resolution
      )
    ) {
      selected.push(term);
    }
  }

  return selected.sort(
    (a, b) => a[1] - b[1]
  );
}

function designRow_(n, terms) {
  const row = [1];

  for (const term of terms) {
    const angle =
      ((term[1] * n) % 360) * RAD;

    row.push(
      Math.cos(angle),
      Math.sin(angle)
    );
  }

  return row;
}

function evaluate_(n, terms, coefficients) {
  let result = coefficients[0];

  for (let j = 0; j < terms.length; j++) {
    const angle =
      ((terms[j][1] * n) % 360) * RAD;

    result +=
      coefficients[1 + 2 * j] *
      Math.cos(angle);

    result +=
      coefficients[2 + 2 * j] *
      Math.sin(angle);
  }

  return result;
}

function stats_(a) {
  if (!a.length) {
    return {
      mean: NaN,
      sd: NaN
    };
  }

  const mean =
    a.reduce((sum, x) => sum + x, 0) /
    a.length;

  const variance = a.reduce(
    (sum, x) => sum + (x - mean) * (x - mean),
    0
  ) / Math.max(1, a.length - 1);

  return {
    mean: mean,
    sd: Math.sqrt(variance)
  };
}

function inside3_(x, stat) {
  return Math.abs(x - stat.mean) <=
    Math.max(3 * stat.sd, 1e-10);
}

function fitPair_(rows, terms) {
  const a = rows.map(
    r => designRow_(r.n, terms)
  );

  const b = rows.map(
    r => [r.interval, r.height]
  );

  const coefficients =
    qrLeastSquares_(a, b);

  return {
    time: coefficients.map(r => r[0]),
    height: coefficients.map(r => r[1])
  };
}

function robustFit_(rows) {
  const tStats = stats_(
    rows.map(r => r.interval)
  );

  const hStats = stats_(
    rows.map(r => r.height)
  );

  let used = rows.filter(r =>
    inside3_(r.interval, tStats) &&
    inside3_(r.height, hStats)
  );

  let terms = selectTerms_(used);
  checkSampleSize_(used, terms);

  const first = fitPair_(used, terms);

  const timeResiduals = used.map(r =>
    r.interval -
    evaluate_(r.n, terms, first.time)
  );

  const heightResiduals = used.map(r =>
    r.height -
    evaluate_(r.n, terms, first.height)
  );

  const tr = stats_(timeResiduals);
  const hr = stats_(heightResiduals);

  used = used.filter((r, index) =>
    inside3_(timeResiduals[index], tr) &&
    inside3_(heightResiduals[index], hr)
  );

  terms = selectTerms_(used);
  checkSampleSize_(used, terms);

  const finalFit = fitPair_(used, terms);

  const timeErrors = used.map(r =>
    r.interval -
    evaluate_(r.n, terms, finalFit.time)
  );

  const heightErrors = used.map(r =>
    r.height -
    evaluate_(r.n, terms, finalFit.height)
  );

  const bounds = transitBounds_(used);

  return {
    terms: terms,
    time: finalFit.time,
    height: finalFit.height,
    usedCount: used.length,
    nMin: bounds.min,
    nMax: bounds.max,
    trainingTimeRMSEmin:
      60 * rmse_(timeErrors),
    trainingHeightRMSE:
      rmse_(heightErrors)
  };
}

function checkSampleSize_(rows, terms) {
  const parameters =
    1 + 2 * terms.length;

  if (
    rows.length <
    Math.max(100, 3 * parameters)
  ) {
    throw new Error(
      'Zu wenige verwertbare Beobachtungen für ' +
      terms.length +
      ' Konstituenten.'
    );
  }
}

/*
 * Householder-QR für mehrere rechte Seiten.
 * Kein Bilden von A' A.
 */
function qrLeastSquares_(inputA, inputB) {
  if (
    !inputA.length ||
    inputA.length !== inputB.length
  ) {
    throw new Error(
      'Ungültige Dimensionen der Ausgleichung.'
    );
  }

  const a = inputA.map(
    row => Float64Array.from(row)
  );

  const b = inputB.map(
    row => Float64Array.from(row)
  );

  const m = a.length;
  const p = a[0].length;
  const rhs = b[0].length;

  if (m < p) {
    throw new Error(
      'Unterbestimmtes Ausgleichungssystem.'
    );
  }

  const rankTolerance =
    1e-9 * Math.sqrt(m);

  for (let k = 0; k < p; k++) {
    let norm2 = 0;

    for (let i = k; i < m; i++) {
      norm2 += a[i][k] * a[i][k];
    }

    const norm = Math.sqrt(norm2);

    if (
      !Number.isFinite(norm) ||
      norm < rankTolerance
    ) {
      throw new Error(
        'Numerisch nicht trennbare Modellspalten. ' +
        'Datenabdeckung oder Konstituentenauswahl prüfen.'
      );
    }

    const alpha =
      a[k][k] >= 0 ? -norm : norm;

    const v =
      new Float64Array(m - k);

    v[0] = a[k][k] - alpha;

    for (let i = k + 1; i < m; i++) {
      v[i - k] = a[i][k];
    }

    let vv = 0;

    for (let i = 0; i < v.length; i++) {
      vv += v[i] * v[i];
    }

    const beta = 2 / vv;

    for (let j = k; j < p; j++) {
      let dot = 0;

      for (let i = k; i < m; i++) {
        dot += v[i - k] * a[i][j];
      }

      dot *= beta;

      for (let i = k; i < m; i++) {
        a[i][j] -= dot * v[i - k];
      }
    }

    for (let j = 0; j < rhs; j++) {
      let dot = 0;

      for (let i = k; i < m; i++) {
        dot += v[i - k] * b[i][j];
      }

      dot *= beta;

      for (let i = k; i < m; i++) {
        b[i][j] -= dot * v[i - k];
      }
    }

    a[k][k] = alpha;

    for (let i = k + 1; i < m; i++) {
      a[i][k] = 0;
    }
  }

  const x = Array.from(
    { length: p },
    () => new Array(rhs).fill(0)
  );

  for (let j = 0; j < rhs; j++) {
    for (let i = p - 1; i >= 0; i--) {
      let value = b[i][j];

      for (let k = i + 1; k < p; k++) {
        value -= a[i][k] * x[k][j];
      }

      x[i][j] = value / a[i][i];
    }
  }

  return x;
}

function rmse_(errors) {
  return Math.sqrt(
    errors.reduce(
      (sum, x) => sum + x * x,
      0
    ) / Math.max(1, errors.length)
  );
}

// ============================================================
// Scheitelpunktmodelle erstellen und speichern
// ============================================================

function fitNextClass_(state, out) {
  const sheet =
    out.getSheetByName('Zuordnung');

  const count =
    sheet.getLastRow() - 1;

  if (count < 400) {
    throw new Error(
      'Zu wenige zugeordnete Scheitelpunkte.'
    );
  }

  const all = sheet
    .getRange(2, 1, count, 8)
    .getValues();

  /*
   * Pro (Transitnummer, k) nur ein Scheitel.
   * Bei mehreren Kandidaten gewinnt die zeitlich plausibelste
   * Zuordnung.
   */
  const unique = new Map();

  for (const row of all) {
    const key =
      row[1] + ':' + row[2];

    const event = {
      n: Number(row[1]),
      k: Number(row[2]),
      interval: Number(row[3]),
      height: Number(row[4]),
      time: Number(row[5]),
      score: Number(row[7])
    };

    if (
      !unique.has(key) ||
      event.score < unique.get(key).score
    ) {
      unique.set(key, event);
    }
  }

  /*
   * Vorhandene HW/NW-Paare auf Reihenfolge prüfen.
   * Fehlende Partner sind erlaubt.
   */
  const invalid = new Set();

  for (const [key, event] of unique) {
    if (
      event.k !== 1 &&
      event.k !== 3
    ) {
      continue;
    }

    const lowKey =
      event.n + ':' + (event.k + 1);

    const low = unique.get(lowKey);

    if (low) {
      const duration =
        (low.time - event.time) / HOUR;

      if (
        !(duration > 2 && duration < 11)
      ) {
        invalid.add(key);
        invalid.add(lowKey);
      }
    }
  }

  const k = state.nextK;

  const rows = Array.from(unique.entries())
    .filter(([key, event]) =>
      event.k === k &&
      !invalid.has(key)
    )
    .map(([, event]) => event)
    .sort((a, b) => a.n - b.n);

  if (rows.length < 200) {
    throw new Error(
      'Zu wenige Daten für Ereignisklasse k=' + k
    );
  }

  /*
   * Zeitlicher Test:
   * frühe 80 % der Transitspanne zum Lernen,
   * spätere 20 % zum Testen.
   *
   * Testdaten werden nicht anhand ihres Vorhersageresiduums
   * bereinigt.
   */
  const minN = rows[0].n;
  const maxN = rows[rows.length - 1].n;

  const cutoff =
    minN + 0.8 * (maxN - minN);

  const train = rows.filter(
    r => r.n <= cutoff
  );

  const test = rows.filter(
    r => r.n > cutoff
  );

  let validation = {
    n: 0,
    timeRMSEmin: null,
    heightRMSE: null,
    terms: null
  };

  if (
    train.length >= 200 &&
    test.length >= 40
  ) {
    const testModel = robustFit_(train);

    validation = {
      n: test.length,

      timeRMSEmin: 60 * rmse_(
        test.map(r =>
          r.interval -
          evaluate_(
            r.n,
            testModel.terms,
            testModel.time
          )
        )
      ),

      heightRMSE: rmse_(
        test.map(r =>
          r.height -
          evaluate_(
            r.n,
            testModel.terms,
            testModel.height
          )
        )
      ),

      terms: testModel.terms.length
    };
  }

  const fit = robustFit_(rows);

  const model = {
    version: 2,
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

    trainingTimeRMSEmin:
      fit.trainingTimeRMSEmin,

    trainingHeightRMSE:
      fit.trainingHeightRMSE,

    validation: validation
  };

  out.getSheetByName('Modell')
    .getRange(k + 1, 1, 1, 2)
    .setValues([[
      k,
      JSON.stringify(model)
    ]]);

  appendRows_(
    out.getSheetByName('Koeffizienten'),
    coefficientRows_(model)
  );

  appendRows_(
    out.getSheetByName('Diagnostik'),
    [[
      k,
      rows.length,
      fit.usedCount,
      fit.terms.length,
      fit.trainingTimeRMSEmin,
      fit.trainingHeightRMSE,
      validation.n,

      validation.timeRMSEmin === null
        ? ''
        : validation.timeRMSEmin,

      validation.heightRMSE === null
        ? ''
        : validation.heightRMSE,

      validation.terms === null
        ? ''
        : validation.terms
    ]]
  );

  state.nextK++;

  if (state.nextK > 4) {
    state.stage = 'CURVE_INIT';

    appendRows_(
      out.getSheetByName('Info'),
      [
        [
          'Scheitelpunktmodelle fertig UTC',
          iso_(Date.now())
        ],
        [
          'Nächster Schritt',
          'Ganglinienanalyse aus den minütlichen Messwerten.'
        ]
      ]
    );
  }
}

function coefficientRows_(model) {
  const rows = [];

  for (const item of [
    ['Zeit_h', model.time],
    ['Hoehe_Originaleinheit', model.height]
  ]) {
    const name = item[0];
    const coefficients = item[1];

    rows.push([
      model.k,
      name,
      'MITTEL',
      0,
      coefficients[0],
      0,
      '',
      ''
    ]);

    model.terms.forEach((term, j) => {
      const a = coefficients[1 + 2 * j];
      const b = coefficients[2 + 2 * j];

      // a*cos(theta)+b*sin(theta) = A*cos(theta-phase)
      const phase = (
        Math.atan2(b, a) / RAD + 360
      ) % 360;

      rows.push([
        model.k,
        name,
        term[0],
        term[1],
        a,
        b,
        Math.hypot(a, b),
        phase
      ]);
    });
  }

  return rows;
}

// ============================================================
// Ganglinienanalyse
// ============================================================

/*
 * Raster:
 *
 * t(n,k) = meanUpper(n) + MHWI + (k - 1/2) * Mondtag / K
 *
 * Für K=96:
 * erste Stützstelle 1/8 Mondstunde nach dem um MHWI
 * verschobenen mittleren oberen Transit.
 *
 * Die Anwendung der 39 Glieder auf diese Ganglinienerweiterung
 * kombiniert die beiden Quellen. Der neuere Aufsatz selbst
 * validiert den Satz anhand von HW/NW.
 */

function curveInitialize_(state, out) {
  const points = state.curvePoints;

  const moonDayMs =
    HD.MOON_DAY_H * HOUR;

  const stepMs =
    moonDayMs / points;

  const originMs =
    meanUpper_(0) +
    state.hwLag * HOUR +
    stepMs / 2;

  const nFirst = Math.floor(
    (state.analysisStart - originMs) /
    moonDayMs
  );

  const nLast = Math.floor(
    (state.analysisEnd - 1 - originMs) /
    moonDayMs
  );

  let samples =
    out.getSheetByName('Ganglinie_Daten');

  if (!samples) {
    const headers = ['Transitnummer_n'];

    for (let k = 1; k <= points; k++) {
      headers.push('Wasserstand_k' + k);
    }

    samples = createSheet_(
      out,
      'Ganglinie_Daten',
      headers
    );
  }

  ensureSheetSize_(
    samples,
    nLast - nFirst + 2,
    points + 1
  );

  if (
    !out.getSheetByName('Ganglinie_Modell')
  ) {
    createSheet_(
      out,
      'Ganglinie_Modell',
      ['k', 'JSON']
    );
  }

  ensureSheetSize_(
    out.getSheetByName('Ganglinie_Modell'),
    points + 1,
    2
  );

  if (
    !out.getSheetByName('Ganglinie_Diagnostik')
  ) {
    createSheet_(
      out,
      'Ganglinie_Diagnostik',
      [
        'k',
        'Vorhanden',
        'Verwendet',
        'Glieder',
        'Anpassungs_RMSE_Originaleinheit',
        'Test_N',
        'Test_RMSE_Originaleinheit',
        'Test_Bias_Originaleinheit',
        'Test_Glieder',
        'Belegung_Anteil'
      ]
    );
  }

  ensureSheetSize_(
    out.getSheetByName('Ganglinie_Diagnostik'),
    points + 1,
    10
  );

  if (
    !out.getSheetByName('Ganglinie_Meta')
  ) {
    createSheet_(
      out,
      'Ganglinie_Meta',
      ['Eigenschaft', 'JSON']
    );
  }

  state.curve = {
    version: 2,
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

    analysisStartUTC:
      iso_(state.analysisStart),

    analysisEndUTCExclusive:
      iso_(state.analysisEnd),

    interpolation: 'linear',
    unit: 'Originaleinheit der Quellspalte B'
  };

  writeCurveMeta_(out, state.curve);

  state.curveNextN = nFirst;
  state.stage = 'CURVE_SAMPLE';
}

function writeCurveMeta_(out, meta) {
  out.getSheetByName('Ganglinie_Meta')
    .getRange(2, 1, 1, 2)
    .setValues([[
      'Metadaten',
      JSON.stringify(meta)
    ]]);
}

function curveSampleTime_(meta, n, k) {
  return meta.originMs +
    n * meta.moonDayMs +
    (k - 1) * meta.stepMs;
}

function curveSampleBlock_(state, out) {
  const meta = state.curve;

  const firstN =
    state.curveNextN;

  const lastN = Math.min(
    meta.nLast,
    firstN + HD_CURVE.SAMPLE_DAYS - 1
  );

  const firstTime = curveSampleTime_(
    meta,
    firstN,
    1
  );

  const lastTime = curveSampleTime_(
    meta,
    lastN,
    meta.points
  );

  const readStart = Math.max(
    state.begin,
    Math.floor(
      (firstTime - HD.FIRST_UTC) / MINUTE
    )
  );

  const readEnd = Math.min(
    state.count,
    Math.ceil(
      (lastTime - HD.FIRST_UTC) / MINUTE
    ) + 1
  );

  const values = readMinuteRange_(
    state,
    readStart,
    readEnd
  );

  const rows = [];

  for (let n = firstN; n <= lastN; n++) {
    const row = [n];

    for (let k = 1; k <= meta.points; k++) {
      const time = curveSampleTime_(
        meta,
        n,
        k
      );

      if (
        time < state.analysisStart ||
        time >= state.analysisEnd
      ) {
        row.push('');
        continue;
      }

      const position =
        (time - HD.FIRST_UTC) / MINUTE;

      const left =
        Math.floor(position);

      const fraction =
        position - left;

      let height = NaN;

      if (
        left >= readStart &&
        left < readEnd
      ) {
        const a =
          values[left - readStart];

        if (fraction === 0) {
          height = a;

        } else if (left + 1 < readEnd) {
          const b =
            values[left + 1 - readStart];

          if (
            Number.isFinite(a) &&
            Number.isFinite(b)
          ) {
            height =
              a + fraction * (b - a);
          }
        }
      }

      row.push(
        Number.isFinite(height)
          ? height
          : ''
      );
    }

    rows.push(row);
  }

  /*
   * Feste Zielzeilen:
   * Wiederholung nach Abbruch erzeugt keine Duplikate.
   */
  out.getSheetByName('Ganglinie_Daten')
    .getRange(
      2 + firstN - meta.nFirst,
      1,
      rows.length,
      meta.points + 1
    )
    .setValues(rows);

  state.curveNextN =
    lastN + 1;

  if (
    state.curveNextN > meta.nLast
  ) {
    state.curveK = 1;
    state.curveFitStage = 'TRAIN_FIRST';
    state.stage = 'CURVE_FIT';
  }
}

function curveReadPhase_(state, out) {
  const meta = state.curve;

  const count =
    meta.nLast - meta.nFirst + 1;

  const values = out.getSheetByName('Ganglinie_Daten')
    .getRange(
      2,
      state.curveK + 1,
      count,
      1
    )
    .getValues();

  const rows = [];

  for (let i = 0; i < values.length; i++) {
    const value = values[i][0];

    if (
      typeof value === 'number' &&
      Number.isFinite(value)
    ) {
      rows.push({
        n: meta.nFirst + i,
        height: value
      });
    }
  }

  return rows;
}

function curveInitialFilter_(rows) {
  const stat = stats_(
    rows.map(r => r.height)
  );

  return rows.filter(
    r => inside3_(r.height, stat)
  );
}

function curveFitHeight_(rows, terms) {
  checkSampleSize_(rows, terms);

  const a = rows.map(
    r => designRow_(r.n, terms)
  );

  const b = rows.map(
    r => [r.height]
  );

  return qrLeastSquares_(a, b)
    .map(r => r[0]);
}

/*
 * Erste Ausgleichung nach 3-Sigma-Filter um den Mittelwert.
 * Eine QR-Ausgleichung pro Aufruf.
 */
function curveFirstFit_(rows) {
  const used =
    curveInitialFilter_(rows);

  const terms =
    selectTerms_(used);

  return {
    terms: terms,
    height: curveFitHeight_(used, terms)
  };
}

/*
 * Zweite Ausgleichung mit zusätzlichem 3-Sigma-Residuenfilter.
 */
function curveSecondFit_(rows, first) {
  let used =
    curveInitialFilter_(rows);

  const errors = used.map(r =>
    r.height -
    evaluate_(
      r.n,
      first.terms,
      first.height
    )
  );

  const stat = stats_(errors);

  used = used.filter(
    (r, i) => inside3_(errors[i], stat)
  );

  const terms =
    selectTerms_(used);

  const height =
    curveFitHeight_(used, terms);

  const residuals = used.map(r =>
    r.height -
    evaluate_(r.n, terms, height)
  );

  const bounds =
    transitBounds_(used);

  return {
    terms: terms,
    height: height,
    usedCount: used.length,
    nMin: bounds.min,
    nMax: bounds.max,
    trainingHeightRMSE:
      rmse_(residuals)
  };
}

/*
 * Je Stützstelle vier getrennte Triggeraufrufe:
 *
 * 1. Trainingsausgleichung, erster Durchgang.
 * 2. Trainingsausgleichung, zweiter Durchgang + zeitlicher Test.
 * 3. Gesamtausgleichung, erster Durchgang.
 * 4. Gesamtausgleichung, zweiter Durchgang + Speicherung.
 *
 * Die Testdaten werden nicht anhand ihrer Vorhersageresiduen
 * gefiltert.
 *
 * Der Test betrifft die Koeffizientenanpassung bei festem
 * Ganglinienraster. Der Rasterursprung stammt aus der
 * vorgeschalteten Intervallschätzung.
 */
function curveFitStep_(state, out) {
  const rows =
    curveReadPhase_(state, out);

  const meta =
    state.curve;

  if (rows.length < 200) {
    throw new Error(
      'Zu wenige Gangliniendaten für k=' +
      state.curveK
    );
  }

  const cutoff =
    meta.nFirst +
    0.8 * (meta.nLast - meta.nFirst);

  const train = rows.filter(
    r => r.n <= cutoff
  );

  const test = rows.filter(
    r => r.n > cutoff
  );

  switch (state.curveFitStage) {
    case 'TRAIN_FIRST':
      state.curveValidation = {
        n: 0,
        rmse: null,
        bias: null,
        terms: null
      };

      if (
        train.length >= 200 &&
        test.length >= 40
      ) {
        state.curvePreliminary =
          curveFirstFit_(train);

        state.curveFitStage =
          'TRAIN_SECOND';

      } else {
        state.curveFitStage =
          'FINAL_FIRST';
      }

      return;

    case 'TRAIN_SECOND': {
      const fit = curveSecondFit_(
        train,
        state.curvePreliminary
      );

      const errors = test.map(r =>
        r.height -
        evaluate_(
          r.n,
          fit.terms,
          fit.height
        )
      );

      state.curveValidation = {
        n: test.length,
        rmse: rmse_(errors),
        bias: stats_(errors).mean,
        terms: fit.terms.length
      };

      delete state.curvePreliminary;

      state.curveFitStage =
        'FINAL_FIRST';

      return;
    }

    case 'FINAL_FIRST':
      state.curvePreliminary =
        curveFirstFit_(rows);

      state.curveFitStage =
        'FINAL_SECOND';

      return;

    case 'FINAL_SECOND': {
      const fit = curveSecondFit_(
        rows,
        state.curvePreliminary
      );

      const model = {
        version: 2,
        kind: 'HDDU_HYDROGRAPH',
        k: state.curveK,

        terms: fit.terms,
        height: fit.height,

        nMin: fit.nMin,
        nMax: fit.nMax,

        availableCount: rows.length,
        usedCount: fit.usedCount,

        trainingHeightRMSE:
          fit.trainingHeightRMSE,

        validation:
          state.curveValidation
      };

      out.getSheetByName('Ganglinie_Modell')
        .getRange(
          state.curveK + 1,
          1,
          1,
          2
        )
        .setValues([[
          state.curveK,
          JSON.stringify(model)
        ]]);

      const validation =
        state.curveValidation;

      out.getSheetByName('Ganglinie_Diagnostik')
        .getRange(
          state.curveK + 1,
          1,
          1,
          10
        )
        .setValues([[
          state.curveK,
          rows.length,
          fit.usedCount,
          fit.terms.length,
          fit.trainingHeightRMSE,
          validation.n,

          validation.rmse === null
            ? ''
            : validation.rmse,

          validation.bias === null
            ? ''
            : validation.bias,

          validation.terms === null
            ? ''
            : validation.terms,

          rows.length /
            (meta.nLast - meta.nFirst + 1)
        ]]);

      delete state.curvePreliminary;
      delete state.curveValidation;

      state.curveK++;
      state.curveFitStage = 'TRAIN_FIRST';

      if (
        state.curveK > meta.points
      ) {
        state.curve.complete = true;

        state.curve.finishedUTC =
          iso_(Date.now());

        writeCurveMeta_(
          out,
          state.curve
        );

        appendRows_(
          out.getSheetByName('Info'),
          [
            [
              'Gesamte Analyse fertig UTC',
              iso_(Date.now())
            ],
            [
              'Ganglinieninterpolation',
              'Linear zwischen benachbarten synthetisierten ' +
              'Stützstellen; auch über Mondtagsgrenzen hinweg.'
            ],
            [
              'Prüfung',
              'Ganglinie_Diagnostik: Datenbelegung, Gliederzahl, ' +
              'zeitliche Testfehler und Bias prüfen.'
            ],
            [
              'Gültigkeit',
              'Astronomische Gezeitenvorausberechnung, ' +
              'keine meteorologische Gesamtwasserstandsvorhersage.'
            ],
            [
              'Methodischer Hinweis',
              'Der 39-Glieder-Satz wurde im neueren Aufsatz ' +
              'anhand von HW/NW geprüft. Die Ganglinienanwendung ' +
              'kombiniert diesen Satz mit BSH 50/2013.'
            ]
          ]
        );

        state.stage = 'DONE';
      }

      return;
    }

    default:
      throw new Error(
        'Unbekannter Ganglinien-Fit-Schritt: ' +
        state.curveFitStage
      );
  }
}

// ============================================================
// Scheitelpunktvorhersage für einen UTC-Tag
// ============================================================

/**
 * Liefert HW/NW für einen UTC-Kalendertag.
 *
 * Beispiel:
 * vorhersageUTC('2026-11-03')
 */
function vorhersageUTC(datum, ergebnisDateiId) {
  requireAstronomy_();

  const start = parseUTCDate_(datum);
  const end = start + DAY;

  const id = ergebnisDateiId ||
    PropertiesService.getScriptProperties()
      .getProperty(HD.RESULT_KEY);

  if (!id) {
    throw new Error(
      'Noch keine Ergebnisdatei vorhanden.'
    );
  }

  const out =
    SpreadsheetApp.openById(id);

  const modelSheet =
    out.getSheetByName('Modell');

  if (!modelSheet) {
    throw new Error(
      'Die Ergebnisdatei enthält keine Scheitelpunktmodelle.'
    );
  }

  const saved = modelSheet
    .getRange(2, 2, 4, 1)
    .getValues();

  if (
    saved.some(row => !row[0])
  ) {
    throw new Error(
      'Scheitelpunktanalyse noch nicht vollständig.'
    );
  }

  const models = saved.map(
    row => JSON.parse(row[0])
  );

  for (let index = 0; index < models.length; index++) {
    const model = models[index];

    if (
      model.k !== index + 1 ||
      model.basis !== 'MEAN_UPPER_TRANSIT_2013' ||
      model.t0 !== HD.T0 ||
      model.syncMinutes !== HD.SYNC_MINUTES ||
      model.moonDayHours !== HD.MOON_DAY_H
    ) {
      throw new Error(
        'Modell oder Zeitbasis unpassend. Neu analysieren.'
      );
    }
  }

  const cache = {};
  const events = [];
  const warnings = [];

  const moonDayMs =
    HD.MOON_DAY_H * HOUR;

  const nStart = Math.floor(
    (start - meanUpper_(0)) / moonDayMs
  ) - 4;

  const nEnd = Math.ceil(
    (end - meanUpper_(0)) / moonDayMs
  ) + 2;

  for (let n = nStart; n <= nEnd; n++) {
    for (const model of models) {
      const interval = evaluate_(
        n,
        model.terms,
        model.time
      );

      if (
        !Number.isFinite(interval) ||
        Math.abs(interval) > 72
      ) {
        throw new Error(
          'Unplausible extrapolierte Ereigniszeit.'
        );
      }

      const time =
        meanUpper_(n) + interval * HOUR;

      if (
        time < start ||
        time >= end
      ) {
        continue;
      }

      const lower =
        model.k >= 3;

      const q =
        2 * n + (lower ? 1 : 0);

      events.push({
        art:
          model.k % 2 ? 'HW' : 'NW',

        utc:
          iso_(time),

        wasserstand:
          evaluate_(
            n,
            model.terms,
            model.height
          ),

        transitnummer: n,
        k: model.k,

        zugeordneterTransit:
          lower ? 'unterer' : 'oberer',

        transitUTC:
          iso_(trueTransit_(q, cache)),

        verwendeteKonstituenten:
          model.terms.length
      });
    }
  }

  events.sort(
    (a, b) => a.utc.localeCompare(b.utc)
  );

  for (let i = 1; i < events.length; i++) {
    if (
      events[i].art === events[i - 1].art
    ) {
      warnings.push(
        'Nicht alternierende HW/NW-Folge: ' +
        'Modell und Zuordnung prüfen.'
      );
    }
  }

  const dailyTransits =
    greenwichTransitsBetween_(
      start,
      end,
      cache
    );

  const shortestYears = Math.min(
    ...models.map(model =>
      (model.nMax - model.nMin) *
      HD.MOON_DAY_H /
      (24 * 365.2425)
    )
  );

  if (shortestYears < 9) {
    warnings.push(
      'Weniger als neun Jahre Analysedaten: wichtige nahe ' +
      'Frequenzen sind nicht getrennt bestimmbar. ' +
      'Eine Referenzpegelanalyse ist fachlich vorzuziehen.'
    );

  } else if (shortestYears < 18.6133) {
    warnings.push(
      'Weniger als eine vollständige Mondknotenperiode ' +
      'in mindestens einer Ereignisreihe: eingeschränkte ' +
      'Bestimmbarkeit langperiodischer Glieder.'
    );
  }

  const minTerms = Math.min(
    ...models.map(model => model.terms.length)
  );

  if (minTerms < 39) {
    warnings.push(
      'Nicht alle 39 Konstituenten konnten in jeder ' +
      'Ereignisklasse verwendet werden.'
    );
  }

  const latestObservation = Math.min(
    ...models.map(model =>
      Date.parse(model.inputEndUTC)
    )
  );

  if (
    start > latestObservation + 365.2425 * DAY
  ) {
    warnings.push(
      'Vorhersagedatum liegt mehr als ein Jahr hinter ' +
      'dem Ende mindestens einer analysierten Ereignisreihe.'
    );
  }

  warnings.push(
    'Wasserstände in der Originaleinheit der Spalte B; ' +
    'keine automatische Umrechnung nach m oder auf ein Höhendatum.'
  );

  warnings.push(
    'Astronomische Gezeitenvorausberechnung; ' +
    'kein vorhergesagter Windstau und keine aktuelle Abflusskorrektur.'
  );

  return {
    datumUTC: datum,
    ergebnisDateiId: id,
    greenwichTransite: dailyTransits,
    ereignisse: events,
    hinweise: [...new Set(warnings)]
  };
}

function greenwichTransitsBetween_(start, end, cache) {
  const halfMs =
    HD.MOON_DAY_H * HOUR / 2;

  const firstQ = Math.floor(
    (start - meanUpper_(0)) / halfMs
  ) - 2;

  const lastQ = Math.ceil(
    (end - meanUpper_(0)) / halfMs
  ) + 2;

  const result = [];

  for (let q = firstQ; q <= lastQ; q++) {
    const time =
      trueTransit_(q, cache);

    if (
      time < start ||
      time >= end
    ) {
      continue;
    }

    const n =
      Math.floor(q / 2);

    result.push({
      art:
        q - 2 * n ? 'unterer' : 'oberer',

      utc:
        iso_(time),

      transitnummer:
        n
    });
  }

  return result.sort(
    (a, b) => a.utc.localeCompare(b.utc)
  );
}

/**
 * Nur Mondtransite, ohne Pegelanalyse.
 */
function greenwichMondtransiteUTC(datum) {
  requireAstronomy_();

  const start =
    parseUTCDate_(datum);

  return greenwichTransitsBetween_(
    start,
    start + DAY,
    {}
  );
}

function beispiel20261103() {
  const result =
    vorhersageUTC('2026-11-03');

  console.log(
    JSON.stringify(result, null, 2)
  );

  writePrediction_(result);
  return result;
}

function writePrediction_(result) {
  const id = result.ergebnisDateiId ||
    PropertiesService.getScriptProperties()
      .getProperty(HD.RESULT_KEY);

  if (!id) {
    throw new Error('Keine Ergebnisdatei vorhanden.');
  }

  const ss =
    SpreadsheetApp.openById(id);

  let sheet =
    ss.getSheetByName('Vorhersage');

  if (!sheet) {
    sheet = createSheet_(
      ss,
      'Vorhersage',
      [
        'Art',
        'Ereignis UTC',
        'Wasserstand',
        'Transitart',
        'Transit UTC',
        'Transitnummer'
      ]
    );
  }

  sheet.clearContents();

  const rows = [
    [
      'Datum UTC',
      result.datumUTC,
      '',
      '',
      '',
      ''
    ],
    ['', '', '', '', '', ''],
    [
      'Art',
      'Ereignis UTC',
      'Wasserstand_Originaleinheit',
      'Transitart',
      'Transit UTC',
      'Transitnummer'
    ]
  ];

  result.ereignisse.forEach(event => {
    rows.push([
      event.art,
      event.utc,
      event.wasserstand,
      event.zugeordneterTransit,
      event.transitUTC,
      event.transitnummer
    ]);
  });

  rows.push(
    ['', '', '', '', '', '']
  );

  rows.push([
    'Greenwich-Transite des UTC-Tages',
    '',
    '',
    '',
    '',
    ''
  ]);

  result.greenwichTransite.forEach(transit => {
    rows.push([
      transit.art,
      transit.utc,
      '',
      '',
      '',
      transit.transitnummer
    ]);
  });

  rows.push(
    ['', '', '', '', '', '']
  );

  result.hinweise.forEach(text => {
    rows.push([
      'Hinweis',
      text,
      '',
      '',
      '',
      ''
    ]);
  });

  ensureSheetSize_(
    sheet,
    rows.length,
    6
  );

  sheet.getRange(
    1, 1, rows.length, 6
  ).setValues(rows);

  sheet.autoResizeColumns(1, 6);
}

// ============================================================
// Ganglinienmodelle laden und Wasserstände synthetisieren
// ============================================================

function loadCurveModels_(ergebnisDateiId) {
  const id = ergebnisDateiId ||
    PropertiesService.getScriptProperties()
      .getProperty(HD.RESULT_KEY);

  if (!id) {
    throw new Error(
      'Keine Ergebnisdatei vorhanden.'
    );
  }

  const out =
    SpreadsheetApp.openById(id);

  const metaSheet =
    out.getSheetByName('Ganglinie_Meta');

  const modelSheet =
    out.getSheetByName('Ganglinie_Modell');

  if (!metaSheet || !modelSheet) {
    throw new Error(
      'Diese Ergebnisdatei enthält noch keine Ganglinienanalyse.'
    );
  }

  const metaText =
    metaSheet.getRange(2, 2).getValue();

  if (!metaText) {
    throw new Error(
      'Ganglinien-Metadaten fehlen.'
    );
  }

  const meta =
    JSON.parse(metaText);

  if (
    meta.version !== 2 ||
    !meta.complete
  ) {
    throw new Error(
      'Ganglinienanalyse noch nicht vollständig.'
    );
  }

  if (
    !Number.isInteger(meta.points) ||
    meta.points < 1 ||
    !Number.isFinite(meta.originMs) ||
    !Number.isFinite(meta.stepMs) ||
    meta.stepMs <= 0
  ) {
    throw new Error(
      'Ungültige Ganglinien-Metadaten.'
    );
  }

  const saved = modelSheet
    .getRange(
      2,
      2,
      meta.points,
      1
    )
    .getValues();

  const models = saved.map((row, index) => {
    if (!row[0]) {
      throw new Error(
        'Ganglinienmodell fehlt: k=' +
        (index + 1)
      );
    }

    const model =
      JSON.parse(row[0]);

    if (
      model.version !== 2 ||
      model.kind !== 'HDDU_HYDROGRAPH' ||
      model.k !== index + 1 ||
      !Array.isArray(model.terms) ||
      !Array.isArray(model.height) ||
      model.height.length !==
        1 + 2 * model.terms.length ||
      !model.height.every(Number.isFinite)
    ) {
      throw new Error(
        'Ungültiges Ganglinienmodell: k=' +
        (index + 1)
      );
    }

    for (const term of model.terms) {
      if (
        !Array.isArray(term) ||
        !Number.isFinite(term[1])
      ) {
        throw new Error(
          'Ungültige Frequenz im Ganglinienmodell.'
        );
      }
    }

    return model;
  });

  return {
    id: id,
    meta: meta,
    models: models
  };
}

/*
 * Globaler Stützstellenindex:
 *
 * j = n * points + (k - 1)
 *
 * Nach der letzten Stützstelle eines Mondtags folgt
 * die erste Stützstelle des nächsten Mondtags.
 */
function curveGridValue_(j, bundle, cache) {
  if (cache.has(j)) {
    return cache.get(j);
  }

  const points =
    bundle.meta.points;

  const n =
    Math.floor(j / points);

  const index =
    j - n * points;

  const model =
    bundle.models[index];

  const height = evaluate_(
    n,
    model.terms,
    model.height
  );

  if (!Number.isFinite(height)) {
    throw new Error(
      'Nicht endlicher synthetisierter Wasserstand.'
    );
  }

  cache.set(j, height);
  return height;
}

function curveValueAt_(time, bundle, cache) {
  const position =
    (time - bundle.meta.originMs) /
    bundle.meta.stepMs;

  const left =
    Math.floor(position);

  const fraction =
    position - left;

  const a =
    curveGridValue_(left, bundle, cache);

  const b =
    curveGridValue_(left + 1, bundle, cache);

  return a + fraction * (b - a);
}

function curveWarnings_(bundle, start, end) {
  const meta = bundle.meta;

  const termCounts =
    bundle.models.map(m => m.terms.length);

  const minTerms =
    Math.min(...termCounts);

  const maxTerms =
    Math.max(...termCounts);

  const warnings = [
    'Astronomische Gezeitenvorausberechnung; Windstau, Luftdruck ' +
    'und aktuelle Abflussverhältnisse werden nicht vorhergesagt.',

    'Wasserstand in der Originaleinheit und im Höhendatum der Quellen.',

    'Minütliche Ausgabe durch lineare Interpolation eines ' +
    (meta.stepMs / MINUTE).toFixed(4) +
    '-Minuten-Stützstellenrasters; keine garantierte ' +
    'Vorhersagegenauigkeit von einer Minute.'
  ];

  if (minTerms < 39) {
    warnings.push(
      'Nicht alle 39 Glieder waren in jeder Stützstellenreihe ' +
      'auflösbar: verwendet werden ' +
      minTerms + ' bis ' + maxTerms + ' Glieder.'
    );
  }

  const analysisStart =
    Date.parse(meta.analysisStartUTC);

  const analysisEnd =
    Date.parse(meta.analysisEndUTCExclusive);

  if (
    start < analysisStart ||
    end >= analysisEnd
  ) {
    warnings.push(
      'Abfrage enthält Zeiten außerhalb des Analysezeitraums: ' +
      'zeitliche Extrapolation.'
    );
  }

  if (
    end > analysisEnd + 365.2425 * DAY
  ) {
    warnings.push(
      'Abfrage reicht mehr als ein Jahr über das Analyseende hinaus. ' +
      'Änderungen des Pegelregimes und des mittleren Wasserstands prüfen.'
    );
  }

  const minimumCoverage = Math.min(
    ...bundle.models.map(model =>
      model.availableCount /
      (meta.nLast - meta.nFirst + 1)
    )
  );

  if (minimumCoverage < 0.6) {
    warnings.push(
      'Mindestens eine Stützstellenreihe ist zu weniger als ' +
      '60 % mit gültigen Beobachtungen belegt.'
    );
  }

  return warnings;
}

/**
 * Wasserstand für eine einzelne UTC-Minute.
 *
 * Beispiel:
 * wasserstandUTC('2026-10-14 0927Z')
 *
 * Optional:
 * wasserstandUTC('2026-10-14 0927Z', 'ERGEBNISDATEI_ID')
 *
 * Keine Google-Sheets-Custom-Function:
 * Aufruf aus dem Apps-Script-Editor über eine Beispielfunktion
 * oder aus anderem autorisiertem Scriptcode.
 */
function wasserstandUTC(zeitUTC, ergebnisDateiId) {
  const time =
    parseMinuteUTC_(zeitUTC);

  const bundle =
    loadCurveModels_(ergebnisDateiId);

  return {
    utc:
      isoMinute_(time),

    wasserstand:
      curveValueAt_(time, bundle, new Map()),

    einheit:
      bundle.meta.unit,

    methode:
      'HDdU-Ganglinie mit linearer Stützstelleninterpolation',

    stuetzstellenJeMondtag:
      bundle.meta.points,

    stuetzstellenAbstandMinuten:
      bundle.meta.stepMs / MINUTE,

    ergebnisDateiId:
      bundle.id,

    hinweise:
      curveWarnings_(bundle, time, time)
  };
}

/**
 * Wasserstände für einen Zeitraum.
 *
 * Ende inklusive, sofern es auf dem Ausgaberaster liegt.
 *
 * Beispiel:
 * wasserstandZeitraumUTC(
 *   '2026-10-14 0000Z',
 *   '2026-10-14 2359Z',
 *   1
 * )
 *
 * schrittMinuten:
 * positive ganze Zahl, Standard 1.
 */
function wasserstandZeitraumUTC(
  vonUTC,
  bisUTC,
  schrittMinuten,
  ergebnisDateiId
) {
  const start =
    parseMinuteUTC_(vonUTC);

  const end =
    parseMinuteUTC_(bisUTC);

  const step =
    schrittMinuten === undefined
      ? 1
      : schrittMinuten;

  if (
    !Number.isInteger(step) ||
    step < 1
  ) {
    throw new Error(
      'Schrittweite muss eine positive ganze Minutenzahl sein.'
    );
  }

  if (end < start) {
    throw new Error(
      'Endzeit liegt vor der Anfangszeit.'
    );
  }

  const count =
    Math.floor(
      (end - start) / (step * MINUTE)
    ) + 1;

  if (
    count > HD_CURVE.MAX_OUTPUT_ROWS
  ) {
    throw new Error(
      'Zu viele Ausgabewerte. Zeitraum aufteilen ' +
      'oder Schrittweite erhöhen.'
    );
  }

  const bundle =
    loadCurveModels_(ergebnisDateiId);

  const cache =
    new Map();

  const values = [];

  for (let i = 0; i < count; i++) {
    const time =
      start + i * step * MINUTE;

    values.push({
      utc:
        isoMinute_(time),

      wasserstand:
        curveValueAt_(time, bundle, cache)
    });
  }

  return {
    vonUTC:
      isoMinute_(start),

    bisUTC:
      isoMinute_(end),

    schrittMinuten:
      step,

    einheit:
      bundle.meta.unit,

    methode:
      'HDdU-Ganglinie mit linearer Stützstelleninterpolation',

    stuetzstellenJeMondtag:
      bundle.meta.points,

    ergebnisDateiId:
      bundle.id,

    werte:
      values,

    hinweise:
      curveWarnings_(bundle, start, end)
  };
}

/**
 * Schreibt einen Einzelwert oder eine Zeitreihe
 * in Wasserstand_Vorhersage.
 *
 * Das bisherige Blatt wird inhaltlich ersetzt.
 */
function schreibeWasserstand_(result) {
  const out = SpreadsheetApp.openById(
    result.ergebnisDateiId
  );

  let sheet =
    out.getSheetByName('Wasserstand_Vorhersage');

  if (!sheet) {
    sheet = createSheet_(
      out,
      'Wasserstand_Vorhersage',
      [
        'UTC',
        'Wasserstand_Originaleinheit'
      ]
    );
  }

  sheet.clearContents();

  const values = result.werte || [{
    utc: result.utc,
    wasserstand: result.wasserstand
  }];

  const rows = [
    [
      'UTC',
      'Wasserstand_Originaleinheit'
    ]
  ];

  for (const value of values) {
    rows.push([
      value.utc,
      value.wasserstand
    ]);
  }

  rows.push(['', '']);

  for (const warning of result.hinweise) {
    rows.push([
      'Hinweis',
      warning
    ]);
  }

  ensureSheetSize_(
    sheet,
    rows.length,
    2
  );

  const blockSize = 10000;

  for (
    let i = 0;
    i < rows.length;
    i += blockSize
  ) {
    const block =
      rows.slice(i, i + blockSize);

    sheet.getRange(
      i + 1,
      1,
      block.length,
      2
    ).setValues(block);
  }

  sheet.setFrozenRows(1);
}

/**
 * Einzelwertbeispiel, direkt im Editor ausführbar.
 */
function beispielWasserstand20261014() {
  const result = wasserstandUTC(
    '2026-10-14 0927Z'
  );

  console.log(
    JSON.stringify(result, null, 2)
  );

  schreibeWasserstand_(result);
  return result;
}

/**
 * Tagesganglinie mit 1.440 Minutenwerten.
 */
function beispielGanglinie20261014() {
  const result = wasserstandZeitraumUTC(
    '2026-10-14 0000Z',
    '2026-10-14 2359Z',
    1
  );

  schreibeWasserstand_(result);

  console.log(
    result.werte.length +
    ' Wasserstände nach Wasserstand_Vorhersage geschrieben.'
  );

  return result;
}

// ============================================================
// Datumsfunktionen und astronomischer Kontrolltest
// ============================================================

function parseUTCDate_(text) {
  if (
    typeof text !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(text)
  ) {
    throw new Error(
      'Datum als Zeichenfolge YYYY-MM-DD angeben.'
    );
  }

  const time =
    Date.parse(text + 'T00:00:00Z');

  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== text
  ) {
    throw new Error(
      'Ungültiges Datum: ' + text
    );
  }

  return time;
}

/**
 * Zulässige Eingaben:
 *
 * 2026-10-14 0927Z
 * 2026-10-14 09:27Z
 * 2026-10-14T09:27Z
 * 2026-10-14T09:27:00Z
 *
 * Sekunden ungleich null werden nicht akzeptiert.
 */
function parseMinuteUTC_(text) {
  if (typeof text !== 'string') {
    throw new Error(
      'UTC-Zeit bitte als Zeichenfolge angeben.'
    );
  }

  const match = text.trim().match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):?(\d{2})(?::00)?Z$/
  );

  if (!match) {
    throw new Error(
      'UTC-Format: YYYY-MM-DD HHMMZ ' +
      'oder YYYY-MM-DDTHH:MMZ.'
    );
  }

  const canonical =
    match[1] +
    'T' +
    match[2] +
    ':' +
    match[3] +
    ':00Z';

  const time =
    Date.parse(canonical);

  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !==
      canonical.replace('Z', '.000Z')
  ) {
    throw new Error(
      'Ungültige UTC-Zeit: ' + text
    );
  }

  return time;
}

function iso_(ms) {
  return new Date(Math.round(ms))
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}

function isoMinute_(ms) {
  return new Date(ms)
    .toISOString()
    .slice(0, 16) + 'Z';
}

/**
 * Vergleich mit Transitangaben aus Tabelle 6 des BSH-Berichts.
 *
 * Gibt Abweichungen aus; verändert keine Daten.
 */
function testAstronomie() {
  requireAstronomy_();

  const examples = [
    [
      2 * 14468,
      '1991-01-01T00:18:00Z'
    ],
    [
      2 * 14468 + 1,
      '1991-01-01T12:50:00Z'
    ],
    [
      2 * 21172,
      '2009-12-30T23:12:00Z'
    ]
  ];

  const cache = {};

  const result = examples.map(([q, reference]) => {
    const calculated =
      trueTransit_(q, cache);

    return {
      q: q,

      berechnet:
        iso_(calculated),

      tabellenwert:
        reference,

      differenzMinuten:
        (
          calculated -
          Date.parse(reference)
        ) / MINUTE
    };
  });

  console.log(
    JSON.stringify(result, null, 2)
  );

  return result;
}

/*
**Hinweise zum Betrieb:**

- Vor dem Ersetzen der alten Datei einen laufenden alten Analyseauftrag mit `hdduStop()` beenden.
- Die vollständige Analyse kann mehrere Stunden dauern und Apps-Script-Tagesquoten erreichen. Nach einem Quotenreset mit `hdduFortsetzen()` weiterarbeiten.
- Vor Verwendung der Vorhersagen insbesondere `Quellen`, `Diagnostik` und `Ganglinie_Diagnostik` prüfen. Ein dichteres Ganglinienraster ist über `HD_CURVE.POINTS: 288` möglich, erfordert aber eine neue vollständige Analyse.
*/
