/**
 * Rechtenfleth: akvoniveloj
 *
 * Reine Synthese der Modelle aus dem bereitgestellten hddu.gs.
 * Keine Pegeldatenanalyse, keine Trigger, keine Astronomy-Abhängigkeit.
 *
 * Einrichtung im Editor:
 *   importiModelojn
 *
 * Optional nach dem Import:
 *   eksportiModelojn
 *
 * Funktionen mit abschließendem "_" sind nicht über
 * google.script.run aufrufbar.
 */

// Durch die von eksportiModelojn_ erzeugte Deklaration ersetzbar.
const RE_MODEL = null;

const RE = Object.freeze({
  SOURCE_ID: '1xNZYSwJW7zLuSCLyGoJmU7o1ZZlzC1J22v2bBnUG4UA',

  SNAPSHOT_KEY: 'RECHTENFLETH_SNAPSHOT_V1',

  TITLE: 'Rechtenfleth: akvoniveloj',

  // Technischer Auswahlbereich der Oberfläche, keine Gütegarantie.
  MIN_YEAR: 1900,
  MAX_YEAR: 2100,

  // Modellwerte in cm; für die Anzeige in m umrechnen.
  UNIT_EO: 'm',
  DATUM_EO: 'La alteca referenco estas tiu de la fontaj mezuroj.',

  // Nur Anzeigeformat, keine Aussage über Vorhersagegenauigkeit.
  DECIMALS: 2,

  T0: Date.UTC(1949, 11, 31, 21, 8, 0),
  SYNC_MINUTES: 24.23,
  MOON_DAY_HOURS: 2 * 12.4206012,

  MINUTE: 60000,
  HOUR: 3600000,
  DAY: 86400000
});


/* ============================================================
 * Web-App
 * ============================================================ */

function doGet() {
  const template = HtmlService.createTemplateFromFile('index');

  template.minYear = RE.MIN_YEAR;
  template.maxYear = RE.MAX_YEAR;

  return template.evaluate()
    .setTitle(RE.TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Einziger Berechnungsendpunkt für die Oberfläche.
 * Es werden keine Modelle oder Tabellen-IDs an den Browser geliefert.
 */
function kalkuli(dato, horo) {
  try {
    const time = parseInput_(dato, horo);
    const start = parseInput_(dato, '00:00');
    const bundle = loadBundle_();

    const events = predictEvents_(start, bundle.peaks);
    const warnings = makeWarnings_(bundle, start, time, events);

    let level = null;

    if (bundle.curveReady) {
      level = formatNumber_(curveValue_(time, bundle) / 100);
    }

    return {
      ok: true,
      dato: dato,
      horo: horo,
      eventoj: events.map(event => ({
        speco: event.high ? 'Maksimuma akvonivelo' : 'Minimuma akvonivelo',
        tempo: displayEventTime_(event.time),
        nivelo: formatNumber_(event.height / 100)
      })),
      nivelo: level,
      unuo: RE.UNIT_EO,
      kurboPreta: bundle.curveReady,
      niveloMesagho: bundle.curveReady
        ? ''
        : 'La modelo por akvoniveloj je arbitraj horoj ankorau ne estas preta. ' +
          'La administranto devas importi la modelojn post la fino de la analizo.',
      avertoj: warnings,
      importita: displayInstant_(bundle.importedAt)
    };

  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));

    return {
      ok: false,
      mesagho: error && error.eo
        ? error.message
        : 'Ne eblis plenumi la kalkulon. Bonvolu reprovi au kontakti la administranton.'
    };
  }
}


/* ============================================================
 * Einrichtung: unabhängige Momentaufnahme importieren
 * ============================================================ */

/**
 * Nur im Editor des NEUEN, tabellengebundenen Projekts ausführen.
 *
 * Jeder Import legt ein neues Modellblatt an.
 * Erst nach erfolgreichem Schreiben wird die aktive Referenz
 * umgestellt. Alte Momentaufnahmen bleiben erhalten.
 */
function importiModelojn_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const destination = SpreadsheetApp.getActiveSpreadsheet();

    if (!destination) {
      throw new Error(
        'Diese Funktion im an die neue Tabelle gebundenen Projekt ausführen.'
      );
    }

    if (destination.getId() === RE.SOURCE_ID) {
      throw new Error(
        'Nicht im Analyseprojekt ausführen. Eine neue Tabelle verwenden.'
      );
    }

    const source = SpreadsheetApp.openById(RE.SOURCE_ID);
    const peakSheet = source.getSheetByName('Modell');

    if (!peakSheet || peakSheet.getLastRow() < 5) {
      throw new Error('Die vier Scheitelpunktmodelle fehlen noch.');
    }

    const peaks = peakSheet.getRange(2, 2, 4, 1)
      .getValues()
      .map((row, index) =>
        parseModelJson_(row[0], 'Modell k=' + (index + 1))
      );

    peaks.forEach((model, index) => validatePeak_(model, index + 1));

    const infoSheet = source.getSheetByName('Info');
    const sourceStage = infoSheet
      ? String(infoSheet.getRange('B6').getValue()).trim()
      : '';

    const metaSheet = source.getSheetByName('Ganglinie_Meta');
    const curveSheet = source.getSheetByName('Ganglinie_Modell');

    let meta = null;
    let curves = [];
    let curveReady = false;

    if (metaSheet) {
      const text = metaSheet.getRange('B2').getValue();

      if (text !== '') {
        meta = parseModelJson_(text, 'Ganglinie_Meta');
        validateMeta_(meta);
      }
    }

    /*
     * Bewusst konservative Freigabe:
     * kompletter Metadatensatz UND Status DONE.
     * Teilmodelle aus CURVE_FIT werden nicht verwendet.
     */
    if (sourceStage === 'DONE') {
      if (!meta || meta.complete !== true || !curveSheet) {
        throw new Error(
          'Status DONE, aber vollständige Gangliniendaten fehlen.'
        );
      }

      if (curveSheet.getLastRow() < meta.points + 1) {
        throw new Error('Ganglinie_Modell enthält zu wenige Modelle.');
      }

      curves = curveSheet.getRange(2, 2, meta.points, 1)
        .getValues()
        .map((row, index) =>
          parseModelJson_(row[0], 'Ganglinie_Modell k=' + (index + 1))
        );

      curves.forEach((model, index) =>
        validateCurve_(model, index + 1)
      );

      curveReady = true;
    }

    const bundle = {
      schema: 1,
      sourceId: RE.SOURCE_ID,
      sourceStage: sourceStage,
      importedAt: new Date().toISOString(),
      peaks: peaks,
      meta: meta,
      curves: curves,
      curveReady: curveReady
    };

    validateBundle_(bundle);

    const name = 'Modeloj_' +
      Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd_HHmmss') +
      '_' + Utilities.getUuid().slice(0, 6);

    const sheet = destination.insertSheet(name);
    const rows = bundleRows_(bundle);

    if (sheet.getMaxRows() < rows.length) {
      sheet.insertRowsAfter(
        sheet.getMaxRows(),
        rows.length - sheet.getMaxRows()
      );
    }

    if (sheet.getMaxColumns() > 3) {
      sheet.deleteColumns(4, sheet.getMaxColumns() - 3);
    }

    sheet.getRange(1, 1, rows.length, 3).setValues(rows);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 130);
    sheet.setColumnWidth(2, 70);
    sheet.setColumnWidth(3, 700);

    destination.setSpreadsheetTimeZone('Etc/UTC');
    SpreadsheetApp.flush();

    // Referenz erst nach vollständig geschriebenem Snapshot umstellen.
    PropertiesService.getScriptProperties().setProperty(
      RE.SNAPSHOT_KEY,
      JSON.stringify({
        spreadsheetId: destination.getId(),
        sheetId: sheet.getSheetId()
      })
    );

    console.log('Momentaufnahme: ' + destination.getUrl() +
      '#gid=' + sheet.getSheetId());

    console.log(curveReady
      ? 'Import vollständig: Scheitelpunkte und Ganglinie.'
      : 'Scheitelpunkte importiert. Ganglinie noch nicht freigegeben. ' +
        'Nach DONE erneut importieren.');

    if (RE_MODEL !== null) {
      console.log(
        'ACHTUNG: RE_MODEL ist bereits eingebettet und hat im Webbetrieb ' +
        'Vorrang. Für eine Aktualisierung erneut exportieren und ersetzen.'
      );
    }

  } finally {
    lock.releaseLock();
  }
}


/* ============================================================
 * Optionaler Export zur direkten Einbettung in Code.gs
 * ============================================================ */

/**
 * Exportiert ausdrücklich die zuletzt importierte Tabellenmomentaufnahme,
 * nicht eine eventuell schon eingebettete ältere Konstante.
 *
 * Erzeugt eine private Textdatei in Google Drive.
 * Der vollständige Dateiinhalt ersetzt "const RE_MODEL = null;".
 */
function eksportiModelojn_() {
  const bundle = loadSnapshot_();
  validateBundle_(bundle);

  const text =
    'const RE_MODEL = ' +
    JSON.stringify(bundle, null, 2) +
    ';\n';

  const name = 'Rechtenfleth_modeloj_' +
    Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd_HHmmss') +
    '.txt';

  const file = DriveApp.createFile(name, text, MimeType.PLAIN_TEXT);

  console.log('Datei mit der einzufügenden Konstante: ' + file.getUrl());

  if (!bundle.curveReady) {
    console.log(
      'Diese Momentaufnahme enthält noch keine fertige Ganglinie. ' +
      'Nach DONE erneut importieren und exportieren.'
    );
  }
}


/* ============================================================
 * Modelle speichern und laden
 * ============================================================ */

function bundleRows_(bundle) {
  const header = {
    schema: bundle.schema,
    sourceId: bundle.sourceId,
    sourceStage: bundle.sourceStage,
    importedAt: bundle.importedAt,
    curveReady: bundle.curveReady
  };

  const rows = [
    ['Tipo', 'Numero', 'Datumoj'],
    ['info', 0, JSON.stringify(header)]
  ];

  bundle.peaks.forEach(model => {
    rows.push(['peak', model.k, JSON.stringify(model)]);
  });

  if (bundle.meta) {
    rows.push(['meta', 0, JSON.stringify(bundle.meta)]);
  }

  bundle.curves.forEach(model => {
    rows.push(['curve', model.k, JSON.stringify(model)]);
  });

  return rows;
}

function loadBundle_() {
  const bundle = RE_MODEL !== null ? RE_MODEL : loadSnapshot_();
  validateBundle_(bundle);
  return bundle;
}

function loadSnapshot_() {
  const refText = PropertiesService.getScriptProperties()
    .getProperty(RE.SNAPSHOT_KEY);

  if (!refText) {
    fail_(
      'La modeloj ankorau ne estas instalitaj. ' +
      'Bonvolu kontakti la administranton.'
    );
  }

  const ref = JSON.parse(refText);
  const ss = SpreadsheetApp.openById(ref.spreadsheetId);
  const sheet = ss.getSheets().find(s => s.getSheetId() === ref.sheetId);

  if (!sheet) {
    fail_('La konservita modelaro mankas.');
  }

  const count = sheet.getLastRow() - 1;

  if (count < 5 || count > 300) {
    fail_('La konservita modelaro ne estas valida.');
  }

  const rows = sheet.getRange(2, 1, count, 3).getValues();

  let info = null;
  let meta = null;
  const peaks = [];
  const curves = [];

  rows.forEach(row => {
    const type = row[0];
    const model = parseModelJson_(row[2], String(type));

    switch (type) {
      case 'info':
        if (info !== null) fail_('La modelaro enhavas duoblan kapon.');
        info = model;
        break;

      case 'meta':
        if (meta !== null) fail_('La modelaro enhavas duoblajn metadatumojn.');
        meta = model;
        break;

      case 'peak':
        if (Number(row[1]) !== model.k) {
          fail_('Nevalida modelnumero.');
        }
        peaks.push(model);
        break;

      case 'curve':
        if (Number(row[1]) !== model.k) {
          fail_('Nevalida modelnumero.');
        }
        curves.push(model);
        break;

      default:
        fail_('Nekonata modeltipo.');
    }
  });

  if (!info) fail_('La kapo de la modelaro mankas.');

  peaks.sort((a, b) => a.k - b.k);
  curves.sort((a, b) => a.k - b.k);

  return {
    schema: info.schema,
    sourceId: info.sourceId,
    sourceStage: info.sourceStage,
    importedAt: info.importedAt,
    curveReady: info.curveReady,
    peaks: peaks,
    meta: meta,
    curves: curves
  };
}

function parseModelJson_(text, label) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Modell-JSON fehlt: ' + label);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Ungültiges Modell-JSON: ' + label);
  }
}


/* ============================================================
 * Modellvalidierung
 * ============================================================ */

function validateBundle_(bundle) {
  if (
    !bundle ||
    bundle.schema !== 1 ||
    !Number.isFinite(Date.parse(bundle.importedAt)) ||
    !Array.isArray(bundle.peaks) ||
    bundle.peaks.length !== 4 ||
    !Array.isArray(bundle.curves) ||
    typeof bundle.curveReady !== 'boolean'
  ) {
    fail_('La modelaro ne estas valida.');
  }

  bundle.peaks.forEach((model, index) =>
    validatePeak_(model, index + 1)
  );

  if (bundle.meta !== null) {
    validateMeta_(bundle.meta);
  }

  if (bundle.curveReady) {
    if (
      bundle.sourceStage !== 'DONE' ||
      !bundle.meta ||
      bundle.meta.complete !== true ||
      bundle.curves.length !== bundle.meta.points
    ) {
      fail_('La modelaro por la akvonivela kurbo ne estas kompleta.');
    }

    bundle.curves.forEach((model, index) =>
      validateCurve_(model, index + 1)
    );

  } else if (bundle.curves.length !== 0) {
    fail_('Nekompleta akvonivela kurbo ne estas uzebla.');
  }
}

function validateTerms_(model, fields) {
  if (
    !model ||
    !Array.isArray(model.terms) ||
    model.terms.length > 39
  ) {
    fail_('Nevalidaj harmonaj komponantoj.');
  }

  const names = new Set();

  model.terms.forEach(term => {
    if (
      !Array.isArray(term) ||
      typeof term[0] !== 'string' ||
      !Number.isFinite(term[1]) ||
      term[1] <= 0 ||
      names.has(term[0])
    ) {
      fail_('Nevalida frekvenco au duobla komponanto.');
    }
    names.add(term[0]);
  });

  fields.forEach(field => {
    const coefficients = model[field];

    if (
      !Array.isArray(coefficients) ||
      coefficients.length !== 1 + 2 * model.terms.length ||
      !coefficients.every(Number.isFinite)
    ) {
      fail_('Nevalidaj modelkoeficientoj.');
    }
  });

  if (
    !Number.isFinite(model.nMin) ||
    !Number.isFinite(model.nMax) ||
    model.nMax < model.nMin
  ) {
    fail_('Nevalida analiza intervalo.');
  }
}

function validatePeak_(model, k) {
  if (
    !model ||
    model.version !== 2 ||
    model.k !== k ||
    model.basis !== 'MEAN_UPPER_TRANSIT_2013' ||
    model.t0 !== RE.T0 ||
    model.syncMinutes !== RE.SYNC_MINUTES ||
    model.moonDayHours !== RE.MOON_DAY_HOURS ||
    !Number.isFinite(Date.parse(model.inputStartUTC)) ||
    !Number.isFinite(Date.parse(model.inputEndUTC))
  ) {
    fail_('La modelo por maksimuma / minimuma akvonivelo ne kongruas kun la tempobazo.');
  }

  validateTerms_(model, ['time', 'height']);
}

function validateCurve_(model, k) {
  if (
    !model ||
    model.version !== 2 ||
    model.kind !== 'HDDU_HYDROGRAPH' ||
    model.k !== k ||
    !Number.isFinite(model.availableCount) ||
    model.availableCount < 1
  ) {
    fail_('Nevalida modelo por la akvonivela kurbo.');
  }

  validateTerms_(model, ['height']);
}

function validateMeta_(meta) {
  const moonDayMs = RE.MOON_DAY_HOURS * RE.HOUR;

  if (
    !meta ||
    meta.version !== 2 ||
    typeof meta.complete !== 'boolean' ||
    !Number.isInteger(meta.points) ||
    meta.points < 96 ||
    meta.points > 288 ||
    meta.t0 !== RE.T0 ||
    meta.syncMinutes !== RE.SYNC_MINUTES ||
    meta.moonDayHours !== RE.MOON_DAY_HOURS ||
    !Number.isFinite(meta.originMs) ||
    !Number.isFinite(meta.stepMs) ||
    meta.stepMs <= 0 ||
    !Number.isFinite(meta.moonDayMs) ||
    Math.abs(meta.moonDayMs - moonDayMs) > 0.01 ||
    Math.abs(meta.stepMs * meta.points - moonDayMs) > 0.01 ||
    !Number.isFinite(meta.hwLagHours) ||
    !Number.isInteger(meta.nFirst) ||
    !Number.isInteger(meta.nLast) ||
    meta.nLast < meta.nFirst ||
    meta.interpolation !== 'linear' ||
    !Number.isFinite(Date.parse(meta.analysisStartUTC)) ||
    !Number.isFinite(Date.parse(meta.analysisEndUTCExclusive)) ||
    Date.parse(meta.analysisEndUTCExclusive) <= Date.parse(meta.analysisStartUTC)
  ) {
    fail_('La metadatumoj de la akvonivela kurbo ne estas validaj.');
  }

  const expectedOrigin =
    meanUpper_(0) +
    meta.hwLagHours * RE.HOUR +
    meta.stepMs / 2;

  if (Math.abs(meta.originMs - expectedOrigin) > 0.01) {
    fail_('La origino de la akvonivela tempokrado ne kongruas.');
  }
}


/* ============================================================
 * Synthese
 * ============================================================ */

function meanUpper_(n) {
  return RE.T0 +
    RE.SYNC_MINUTES * RE.MINUTE +
    n * RE.MOON_DAY_HOURS * RE.HOUR;
}

/**
 * Exakt dieselbe Koeffizientenreihenfolge wie in hddu.gs:
 * c0, cos1, sin1, cos2, sin2, ...
 *
 * Frequenzen werden aus den Modellen übernommen.
 * Keine Ersetzung durch andere Tabellenwerte.
 */
function evaluate_(n, terms, coefficients) {
  let result = coefficients[0];

  for (let j = 0; j < terms.length; j++) {
    const angle = ((terms[j][1] * n) % 360) * Math.PI / 180;

    result += coefficients[1 + 2 * j] * Math.cos(angle);
    result += coefficients[2 + 2 * j] * Math.sin(angle);
  }

  if (!Number.isFinite(result)) {
    fail_('La kalkulo liveris nevalidan valoron.');
  }

  return result;
}

function predictEvents_(start, models) {
  const end = start + RE.DAY;
  const period = RE.MOON_DAY_HOURS * RE.HOUR;

  /*
   * Beidseitiger Suchrand für die zugelassene Intervallgröße
   * von maximal 72 Stunden.
   */
  const firstN = Math.floor((start - meanUpper_(0)) / period) - 4;
  const lastN = Math.ceil((end - meanUpper_(0)) / period) + 4;

  const events = [];

  for (let n = firstN; n <= lastN; n++) {
    for (const model of models) {
      const interval = evaluate_(n, model.terms, model.time);

      if (Math.abs(interval) > 72) {
        fail_('La modelo liveris neklarigeblan tempon de maksimuma au minimuma akvonivelo.');
      }

      /*
       * Auch k=3 und k=4 beziehen sich auf den mittleren OBEREN
       * Transit derselben Nummer n. Kein zusätzlicher Halbmondtag!
       */
      const time = meanUpper_(n) + interval * RE.HOUR;

      if (time >= start && time < end) {
        events.push({
          time: time,
          height: evaluate_(n, model.terms, model.height),
          high: model.k % 2 === 1,
          k: model.k,
          n: n
        });
      }
    }
  }

  return events.sort((a, b) => a.time - b.time);
}

function curveValue_(time, bundle) {
  const meta = bundle.meta;
  const position = (time - meta.originMs) / meta.stepMs;
  const left = Math.floor(position);
  const fraction = position - left;

  const a = curveGridValue_(left, bundle);
  const b = curveGridValue_(left + 1, bundle);

  const value = a + fraction * (b - a);

  if (!Number.isFinite(value)) {
    fail_('Ne eblis kalkuli la akvonivelon.');
  }

  return value;
}

function curveGridValue_(j, bundle) {
  const points = bundle.meta.points;

  // Math.floor ist auch bei negativen Transitnummern erforderlich.
  const n = Math.floor(j / points);
  const index = j - n * points;
  const model = bundle.curves[index];

  return evaluate_(n, model.terms, model.height);
}


/* ============================================================
 * Hinweise für die Oberfläche: ausschließlich Esperanto
 * ============================================================ */

function makeWarnings_(bundle, start, time, events) {
  const warnings = [
    'Neoficiala astronomia prognozo de maksimuma kaj minimuma akvoniveloj, ne de mezuritaj akvoniveloj. ' +
    'Ne uzu ghin kiel solan bazon por navigado au sekurecaj decidoj.',

    'Vento, aerpremo kaj aktualaj riveraj alfluoj ne estas prognozataj.',

    'La akvoniveloj estas montrataj en metroj, konvertitaj el centimetroj. ' +
    RE.DATUM_EO,

    'La tempoj de maksimuma kaj minimuma akvonivelo devenas de apartaj modeloj; ' +
    'ili ne devas ekzakte koincidi kun la ekstremoj de la akvonivela kurbo.',

    'La tempoj estas rondigitaj al la plej proksima minuto. ' +
    'Tio ne signifas precizecon de unu minuto.'
  ];

  let peakExtrapolation = false;

  for (const event of events) {
    const model = bundle.peaks[event.k - 1];

    if (event.n < model.nMin || event.n > model.nMax) {
      peakExtrapolation = true;
    }
  }

  if (peakExtrapolation) {
    warnings.push(
      'La tempoj de maksimuma kaj miniumuma akvoniveloj estas ekster la analizita transitintervalo: ekstrapolo.'
    );
  }

  const shortestYears = Math.min.apply(
    null,
    bundle.peaks.map(model =>
      (model.nMax - model.nMin) *
      RE.MOON_DAY_HOURS / (24 * 365.2425)
    )
  );

  if (shortestYears < 9) {
    warnings.push(
      'Almenau unu modelo por la tempoj de maksimuma kaj minimuma akvonivelo uzas malpli ol nau jarojn ' +
      'da datumoj. Proksimaj frekvencoj ne estas plene apartigeblaj.'
    );
  } else if (shortestYears < 18.6133) {
    warnings.push(
      'Almenau unu modelo por tempoj de maksimuma kaj minimuma akvonivelo ne kovras tutan lunan nodperiodon.'
    );
  }

  const allModels = bundle.peaks.concat(bundle.curves);
  const counts = allModels.map(model => model.terms.length);
  const minTerms = Math.min.apply(null, counts);
  const maxTerms = Math.max.apply(null, counts);

  if (minTerms < 39) {
    warnings.push(
      'Ne chiuj modeloj uzas chiujn 39 harmonajn komponantojn. ' +
      'La nombro varias de ' + minTerms + ' ghis ' + maxTerms + '.'
    );
  }

  for (let i = 1; i < events.length; i++) {
    if (events[i].high === events[i - 1].high) {
      warnings.push(
        'La sinsekvo de maksimuma kaj minimuma akvoniveloj ne alternas. ' +
        'La modeloj bezonas kontrolon.'
      );
      break;
    }
  }

  const latestPeakEnd = Math.min.apply(
    null,
    bundle.peaks.map(model => Date.parse(model.inputEndUTC))
  );

  if (start > latestPeakEnd + 365.2425 * RE.DAY) {
    warnings.push(
      'La elektita tago estas pli ol unu jaron post la fino de ' +
      'almenau unu analizita serio de maksimuma kaj minimuma akvonivelo. La lokaj kondichoj povis shanghighi.'
    );
  }

  if (bundle.curveReady) {
    const meta = bundle.meta;
    const analysisStart = Date.parse(meta.analysisStartUTC);
    const analysisEnd = Date.parse(meta.analysisEndUTCExclusive);

    warnings.push(
      'La akvonivelo estas lineare interpolita inter modelaj apogpunktoj ' +
      'kun interspaco de ' +
      (meta.stepMs / RE.MINUTE).toFixed(3).replace('.', ',') +
      ' minutoj.'
    );

    if (time < analysisStart || time >= analysisEnd) {
      warnings.push(
        'La elektita momento estas ekster la analiza periodo de la ' +
        'akvonivela kurbo: ekstrapolo.'
      );
    }

    // Auch die tatsächlich verwendeten beiden Stützstellen prüfen.
    const position = (time - meta.originMs) / meta.stepMs;
    const left = Math.floor(position);

    const outsidePhaseSpan = [left, left + 1].some(j => {
      const n = Math.floor(j / meta.points);
      const index = j - n * meta.points;
      const model = bundle.curves[index];
      return n < model.nMin || n > model.nMax;
    });

    if (outsidePhaseSpan) {
      warnings.push(
        'Almenau unu uzata apogpunkto estas ekster sia propra ' +
        'analizita transitintervalo.'
      );
    }

    const coverage = Math.min.apply(
      null,
      bundle.curves.map(model =>
        model.availableCount / (meta.nLast - meta.nFirst + 1)
      )
    );

    if (coverage < 0.6) {
      warnings.push(
        'Almenau unu apogpunkta serio enhavas malpli ol 60 procentojn ' +
        'da validaj observoj.'
      );
    }

    if (time > analysisEnd + 365.2425 * RE.DAY) {
      warnings.push(
        'La elektita momento estas pli ol unu jaron post la analiza ' +
        'periodo de la akvonivela kurbo. Kontrolu la aktualecon de la modelo.'
      );
    }
  }

  return Array.from(new Set(warnings));
}


/* ============================================================
 * Datum, Zeit und Ausgabe
 * ============================================================ */

function parseInput_(dato, horo) {
  if (
    typeof dato !== 'string' ||
    typeof horo !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dato) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(horo)
  ) {
    fail_('Bonvolu elekti validajn daton kaj horon en UTK.');
  }

  const year = Number(dato.slice(0, 4));

  if (year < RE.MIN_YEAR || year > RE.MAX_YEAR) {
    fail_(
      'Elektu jaron de ' + RE.MIN_YEAR + ' ghis ' + RE.MAX_YEAR + '.'
    );
  }

  const canonical = dato + 'T' + horo + ':00.000Z';
  const time = Date.parse(canonical);

  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== canonical
  ) {
    fail_('La elektita dato au horo ne estas valida.');
  }

  return time;
}

function formatNumber_(value) {
  const text = value.toFixed(RE.DECIMALS);
  const normalized = Number(text) === 0
    ? (0).toFixed(RE.DECIMALS)
    : text;

  return normalized.replace('.', ',');
}

/**
 * Tageszugehörigkeit wird vor der Rundung geprüft.
 * Das vollständige Datum vermeidet Mehrdeutigkeit, falls z. B.
 * 23:59:40 auf 00:00 des Folgetages gerundet wird.
 */
function displayEventTime_(time) {
  const rounded = Math.round(time / RE.MINUTE) * RE.MINUTE;
  return new Date(rounded).toISOString()
    .slice(0, 16).replace('T', ' ') + ' UTK';
}

function displayInstant_(text) {
  return new Date(text).toISOString()
    .slice(0, 16).replace('T', ' ') + ' UTK';
}

function fail_(message) {
  const error = new Error(message);
  error.eo = true;
  throw error;
}

/**
 * Startfunktionen für die manuelle Ausführung im Editor.
 */
function importiModelojn() {
  // Diese Verwaltungsfunktion nur aus dem tabellengebundenen
  // Editor ausführen, nicht über die Web-App.
  if (!SpreadsheetApp.getActiveSpreadsheet()) {
    throw new Error(
      'Diese Funktion bitte im Apps-Script-Editor der neuen Tabelle ausführen.'
    );
  }

  importiModelojn_();
}

function eksportiModelojn() {
  // Diese Verwaltungsfunktion nur aus dem tabellengebundenen
  // Editor ausführen, nicht über die Web-App.
  if (!SpreadsheetApp.getActiveSpreadsheet()) {
    throw new Error(
      'Diese Funktion bitte im Apps-Script-Editor der neuen Tabelle ausführen.'
    );
  }

  eksportiModelojn_();
}
