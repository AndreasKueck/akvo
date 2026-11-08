/**
 * Code.gs
 *
 * Hamburgo, St. Pauli: akvoniveloj
 *
 * Separates Web-App-Projekt.
 * Reine Synthese der Hamburger V4-Modelle.
 *
 * Keine Rohdatenanalyse.
 * Keine Astronomy-Abhängigkeit.
 * Keine Umrechnung von cm nach m.
 *
 * Einrichtung im Editor:
 *   1. Script Property SOURCE_ID eintragen.
 *   2. Sobald alle vier Scheitelpunktmodelle vorliegen:
 *      importiModelojn ausführen.
 *   3. Nach Analysezustand DONE erneut importiModelojn ausführen,
 *      um zusätzlich die vollständige Ganglinie zu übernehmen.
 *
 * Optional:
 *   eksportiModelojn
 *
 * Interne Verwaltungsfunktionen enden absichtlich auf "_".
 * Sie sind nicht über google.script.run aufrufbar.
 */

const RE_MODEL = null;

const RE = Object.freeze({
  SOURCE_ID: PropertiesService.getScriptProperties().getProperty('SOURCE_ID'),

  SNAPSHOT_KEY: 'HAMBURG_MODEL_SNAPSHOT_V4',

  STATION: 'StPauliTG',
  TITLE: 'Hamburgo ‒ St. Pauli: akvoniveloj',
  SITE_CODE: 'StP',
  DATUM: 'DHHN92 / Amsterdam',
  VERSION: 4,

  MIN_YEAR: 1900,
  MAX_YEAR: 2100,
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

function kalkuli(dato, horo) {
  try {
    const time = reParseInput_(dato, horo);
    const start = reParseInput_(dato, '00:00');
    const bundle = reLoadBundle_();
    const events = rePredictEvents_(start, bundle.peaks);

    const level = bundle.curveReady
      ? reNumber_(reCurveValue_(time, bundle))
      : null;

    return {
      ok: true,
      dato: dato,
      horo: horo,
      nivelo: level,
      unuo: 'm',

      // Auch ohne Ganglinien-Metadaten verfügbar und validiert.
      referenco: bundle.peaks[0].datum,

      kurboPreta: bundle.curveReady,
      niveloMesagho: bundle.curveReady
        ? ''
        : 'La modelo por akvoniveloj je arbitraj horoj ankorau ne estas preta. ' +
          'La administranto devas importi la modelojn post la fino de la analizo.',

      eventoj: events.map(e => ({
        speco: e.high ? 'Maksimuma akvonivelo' : 'Minimuma akvonivelo',
        tempo: reDisplayTime_(e.time),
        nivelo: reNumber_(e.height)
      })),

      avertoj: reWarnings_(bundle, start, time, events),
      importita: reDisplayTime_(Date.parse(bundle.importedAt)),

      // Den Ganglinien-Analysezeitraum erst bei fertiger Ganglinie anzeigen.
      analizaPeriodo: bundle.curveReady
        ? bundle.meta.analysisStartUTC.slice(0, 10) + ' – ' +
          bundle.meta.analysisEndUTCExclusive.slice(0, 10) +
          ' (fino ekskluziva)'
        : null
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
 * Modellimport
 *
 * Der Snapshot wird als private JSON-Datei angelegt.
 * Die aktive Referenz wird erst nach Schreiben und Rücklesen
 * der vollständigen Datei umgestellt.
 *
 * Scheitelpunkte können bereits vor DONE importiert werden.
 * Die Ganglinie wird ausschließlich bei DONE freigegeben.
 * ============================================================ */

function importiModelojn_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    if (!RE.SOURCE_ID || RE.SOURCE_ID.indexOf('HIER_') === 0) {
      throw new Error('Script Property SOURCE_ID eintragen.');
    }

    const source = SpreadsheetApp.openById(RE.SOURCE_ID);
    const info = source.getSheetByName('Info');

    const sourceStage = info
      ? String(info.getRange('B6').getValue()).trim()
      : '';

    const peakSheet = source.getSheetByName('Modell');

    if (!peakSheet || peakSheet.getLastRow() < 5) {
      throw new Error('Die vier Hamburger Scheitelpunktmodelle fehlen noch.');
    }

    const peaks = peakSheet.getRange(2, 2, 4, 1).getValues()
      .map((r, i) => reJson_(r[0], 'Scheitelmodell ' + (i + 1)));

    // Alle vier Scheitelpunktmodelle müssen vollständig gültig sein.
    peaks.forEach((m, i) => reValidateModel_(m, i + 1, false));

    const metaSheet = source.getSheetByName('Ganglinie_Meta');
    const curveSheet = source.getSheetByName('Ganglinie_Modell');

    let meta = null;
    let curves = [];
    let curveReady = false;

    // Metadaten dürfen vor Abschluss der Ganglinienanalyse noch fehlen.
    if (metaSheet) {
      const text = metaSheet.getRange('B2').getValue();

      if (text !== '') {
        meta = reJson_(text, 'Metadaten');
        reValidateMeta_(meta);
      }
    }

    /*
     * Wie bei Bremervörde:
     * Scheitelpunkte unabhängig vom Gesamtstatus importieren.
     * Ganglinie nur bei DONE und vollständigem Modellbestand freigeben.
     * Teilmodelle aus einer laufenden Ganglinienanalyse nicht verwenden.
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

      curves = curveSheet.getRange(2, 2, meta.points, 1).getValues()
        .map((r, i) => reJson_(r[0], 'Ganglinienmodell ' + (i + 1)));

      curves.forEach((m, i) => reValidateModel_(m, i + 1, true));

      curveReady = true;
    }

    const bundle = {
      schema: 4,
      sourceStage: sourceStage,
      sourceId: source.getId(),
      station: RE.STATION,
      importedAt: new Date().toISOString(),
      peaks: peaks,
      meta: meta,
      curves: curves,
      curveReady: curveReady
    };

    reValidateBundle_(bundle);

    const name = 'hamburg_hddu_modeloj_' +
      Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd_HHmmss') +
      '_' + Utilities.getUuid().slice(0, 6) + '.json';

    const text = JSON.stringify(bundle);
    const file = DriveApp.createFile(name, text, MimeType.PLAIN_TEXT);

    const reread = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
    reValidateBundle_(reread);

    // Aktive Referenz erst nach erfolgreichem Schreiben und Rücklesen ändern.
    PropertiesService.getScriptProperties().setProperty(
      RE.SNAPSHOT_KEY,
      JSON.stringify({
        fileId: file.getId(),
        importedAt: bundle.importedAt
      })
    );

    console.log('Modellmomentaufnahme importiert: ' + file.getUrl());
    console.log('Alte Momentaufnahmen bleiben erhalten.');

    console.log(curveReady
      ? 'Import vollständig: Scheitelpunkte und Ganglinie.'
      : 'Scheitelpunkte importiert. Ganglinie noch nicht freigegeben. ' +
        'Nach DONE erneut importieren.');

    if (RE_MODEL !== null) {
      console.log(
        'ACHTUNG: Die eingebettete Konstante RE_MODEL hat Vorrang. ' +
        'Für ein Update erneut exportieren und ersetzen.'
      );
    }

  } finally {
    lock.releaseLock();
  }
}

function eksportiModelojn_() {
  const bundle = reLoadSnapshot_();
  reValidateBundle_(bundle);

  const text = 'const RE_MODEL = ' +
    JSON.stringify(bundle, null, 2) + ';\n';

  const file = DriveApp.createFile(
    'hamburg_modeloj_eingebettet_' +
      Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd_HHmmss') + '.txt',
    text,
    MimeType.PLAIN_TEXT
  );

  console.log(
    'Dateiinhalt ersetzt die gesamte Zeile "const RE_MODEL = null;": ' +
    file.getUrl()
  );

  if (!bundle.curveReady) {
    console.log(
      'Diese Momentaufnahme enthält nur die Scheitelpunktmodelle, ' +
      'noch keine freigegebene Ganglinie. ' +
      'Nach DONE erneut importieren und exportieren.'
    );
  }
}

function reLoadBundle_() {
  const bundle = RE_MODEL !== null ? RE_MODEL : reLoadSnapshot_();
  reValidateBundle_(bundle);
  return bundle;
}

function reLoadSnapshot_() {
  const text = PropertiesService.getScriptProperties()
    .getProperty(RE.SNAPSHOT_KEY);

  if (!text) {
    reFail_(
      'La modeloj ankorau ne estas instalitaj. Bonvolu kontakti la administranton.'
    );
  }

  const reference = JSON.parse(text);

  if (!reference || typeof reference.fileId !== 'string') {
    throw new Error('Ungültige Snapshot-Referenz.');
  }

  return JSON.parse(
    DriveApp.getFileById(reference.fileId)
      .getBlob().getDataAsString('UTF-8')
  );
}

function reJson_(text, label) {
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

function reValidateBundle_(b) {
  if (
    !b ||
    b.schema !== 4 ||
    typeof b.sourceStage !== 'string' ||
    b.station !== RE.STATION ||
    !Number.isFinite(Date.parse(b.importedAt)) ||
    !Array.isArray(b.peaks) ||
    b.peaks.length !== 4 ||
    !Array.isArray(b.curves)
  ) {
    throw new Error('Ungültiges Hamburger Modellpaket.');
  }

  /*
   * Rückwärtskompatibilität:
   * Alte Hamburger Snapshots hatten kein curveReady und waren
   * ausschließlich für DONE vorgesehen.
   * Die Vollständigkeit wird weiter unten weiterhin geprüft.
   */
  if (b.curveReady === undefined && b.sourceStage === 'DONE') {
    b.curveReady = true;
  }

  if (typeof b.curveReady !== 'boolean') {
    throw new Error('Ungültiger Bereitschaftsstatus der Ganglinie.');
  }

  b.peaks.forEach((m, i) => reValidateModel_(m, i + 1, false));

  if (b.meta !== null) {
    reValidateMeta_(b.meta);
  }

  if (b.curveReady) {
    if (
      b.sourceStage !== 'DONE' ||
      !b.meta ||
      b.meta.complete !== true ||
      b.curves.length !== b.meta.points
    ) {
      throw new Error('Unvollständige Ganglinienmodelle.');
    }

    b.curves.forEach((m, i) => reValidateModel_(m, i + 1, true));

  } else if (b.curves.length !== 0) {
    throw new Error(
      'Nicht freigegebene Ganglinien-Teilmodelle dürfen nicht verwendet werden.'
    );
  }
}

function reValidateCommon_(m) {
  if (
    !m ||
    m.version !== RE.VERSION ||
    m.station !== RE.STATION ||
    m.siteCode !== RE.SITE_CODE ||
    m.unit !== 'm' ||
    m.datum !== RE.DATUM ||
    m.t0 !== RE.T0 ||
    m.syncMinutes !== RE.SYNC_MINUTES ||
    m.moonDayHours !== RE.MOON_DAY_HOURS
  ) {
    throw new Error('Station, Einheit, Höhenbezug oder Zeitbasis unpassend.');
  }
}

function reValidateModel_(m, k, curve) {
  reValidateCommon_(m);

  if (
    m.k !== k ||
    m.kind !== (curve ? 'HDDU_HYDROGRAPH' : 'HDDU_PEAK') ||
    !Number.isInteger(m.nMin) ||
    !Number.isInteger(m.nMax) ||
    m.nMax < m.nMin ||
    !Number.isInteger(m.availableCount) ||
    m.availableCount < 1 ||
    !Number.isInteger(m.usedCount) ||
    m.usedCount < 1 ||
    m.usedCount > m.availableCount ||
    !Array.isArray(m.terms) ||
    m.terms.length > 39
  ) {
    throw new Error('Ungültiges Modell k=' + k);
  }

  const names = new Set();
  let previousFrequency = -Infinity;

  m.terms.forEach(term => {
    if (
      !Array.isArray(term) ||
      typeof term[0] !== 'string' ||
      names.has(term[0]) ||
      !Number.isFinite(term[1]) ||
      term[1] <= 0 ||
      term[1] <= previousFrequency
    ) {
      throw new Error('Ungültige oder doppelte Modellfrequenz.');
    }

    names.add(term[0]);
    previousFrequency = term[1];
  });

  const fields = curve ? ['height'] : ['time', 'height'];

  fields.forEach(field => {
    if (
      !Array.isArray(m[field]) ||
      m[field].length !== 1 + 2 * m.terms.length ||
      !m[field].every(Number.isFinite)
    ) {
      throw new Error('Ungültige Koeffizienten.');
    }
  });

  if (!curve && (
    m.basis !== 'MEAN_UPPER_TRANSIT_2013' ||
    !Number.isFinite(Date.parse(m.inputStartUTC)) ||
    !Number.isFinite(Date.parse(m.inputEndUTC)) ||
    Date.parse(m.inputEndUTC) < Date.parse(m.inputStartUTC)
  )) {
    throw new Error('Ungültige Scheitelpunkt-Zeitbasis.');
  }
}

function reValidateMeta_(m) {
  reValidateCommon_(m);

  const period = RE.MOON_DAY_HOURS * RE.HOUR;

  if (
    typeof m.complete !== 'boolean' ||
    !Number.isInteger(m.points) ||
    m.points < 96 ||
    m.points > 288 ||
    !Number.isFinite(m.originMs) ||
    !Number.isFinite(m.stepMs) ||
    m.stepMs <= 0 ||
    !Number.isFinite(m.moonDayMs) ||
    Math.abs(m.moonDayMs - period) > 0.01 ||
    Math.abs(m.stepMs * m.points - period) > 0.01 ||
    !Number.isFinite(m.hwLagHours) ||
    !Number.isInteger(m.nFirst) ||
    !Number.isInteger(m.nLast) ||
    m.nLast < m.nFirst ||
    m.interpolation !== 'linear' ||
    m.sourceStepMinutes !== 10 ||
    m.sourceTimeHandling !== 'UTC' ||
    !Number.isFinite(Date.parse(m.analysisStartUTC)) ||
    !Number.isFinite(Date.parse(m.analysisEndUTCExclusive)) ||
    Date.parse(m.analysisEndUTCExclusive) <= Date.parse(m.analysisStartUTC)
  ) {
    throw new Error('Ungültige Ganglinien-Metadaten.');
  }

  const expectedOrigin =
    reMeanUpper_(0) + m.hwLagHours * RE.HOUR + m.stepMs / 2;

  if (Math.abs(m.originMs - expectedOrigin) > 0.01) {
    throw new Error('Ganglinienursprung stimmt nicht mit der Zeitbasis überein.');
  }
}

/* ============================================================
 * Synthese
 * ============================================================ */

function reMeanUpper_(n) {
  return RE.T0 +
    RE.SYNC_MINUTES * RE.MINUTE +
    n * RE.MOON_DAY_HOURS * RE.HOUR;
}

function reEvaluate_(n, terms, coefficients) {
  let result = coefficients[0];

  for (let j = 0; j < terms.length; j++) {
    const angle = ((terms[j][1] * n) % 360) * Math.PI / 180;
    result += coefficients[1 + 2 * j] * Math.cos(angle);
    result += coefficients[2 + 2 * j] * Math.sin(angle);
  }

  if (!Number.isFinite(result)) {
    throw new Error('Nicht endlicher synthetisierter Wert.');
  }

  return result;
}

function rePredictEvents_(start, models) {
  const end = start + RE.DAY;
  const period = RE.MOON_DAY_HOURS * RE.HOUR;

  const firstN = Math.floor((start - reMeanUpper_(0)) / period) - 4;
  const lastN = Math.ceil((end - reMeanUpper_(0)) / period) + 4;
  const events = [];

  for (let n = firstN; n <= lastN; n++) {
    for (const m of models) {
      const interval = reEvaluate_(n, m.terms, m.time);

      if (Math.abs(interval) > 72) {
        reFail_(
          'La modelo liveris neklarigeblan eventotempon. ' +
          'La elektita dato eble estas tro malproksima de la analiza periodo.'
        );
      }

      // Auch k=3 und k=4 beziehen sich auf den mittleren
      // OBEREN Transit derselben Nummer n.
      const time = reMeanUpper_(n) + interval * RE.HOUR;

      if (time >= start && time < end) {
        events.push({
          time: time,
          height: reEvaluate_(n, m.terms, m.height),
          high: m.k % 2 === 1,
          k: m.k,
          n: n
        });
      }
    }
  }

  return events.sort((a, b) => a.time - b.time);
}

function reCurveGridValue_(j, b) {
  const points = b.meta.points;
  const n = Math.floor(j / points);
  const index = j - n * points;
  const m = b.curves[index];

  return reEvaluate_(n, m.terms, m.height);
}

function reCurveValue_(time, b) {
  if (!b.curveReady) {
    reFail_(
      'La modelo por akvoniveloj je arbitraj horoj ankorau ne estas preta. ' +
      'La administranto devas importi la modelojn post la fino de la analizo.'
    );
  }

  const position = (time - b.meta.originMs) / b.meta.stepMs;
  const left = Math.floor(position);
  const fraction = position - left;

  const a = reCurveGridValue_(left, b);
  const c = reCurveGridValue_(left + 1, b);

  return a + fraction * (c - a);
}

/* ============================================================
 * Esperanto-Hinweise
 * ============================================================ */

function reWarnings_(b, start, time, events) {
  const warnings = [
    'Neoficiala prognozo de la tajda akvonivelo che Hamburgo ‒ St. Pauli. ' +
      'Ne uzu ghin kiel solan bazon por navigado au sekurecaj decidoj.',

    'Vento, aerpremo kaj aktualaj riveraj alfluoj ne estas prognozataj. ' +
      'La efektiva akvonivelo povas konsiderinde diferenci.',

    'La valoroj estas en metroj. La alteca referenco lau la fontdosiero estas "' +
      b.peaks[0].datum + '". Neniu konverto al mezurila nulpunkto au alia ' +
      'alteca sistemo estas aplikita.',

    'La fontaj mezuroj havas 10-minutan kradon. ' +
      'Interpolo kaj rondigo ne signifas precizecon de unu minuto au unu centimetro.'
  ];

  if (b.curveReady) {
    warnings.push(
      'La maksimumaj kaj minimumaj akvoniveloj devenas de apartaj modeloj. ' +
        'Ili ne nepre ekzakte koincidas kun la ekstremoj de la modela akvonivela kurbo.',

      'La akvonivelo je la elektita horo estas lineare interpolita inter modelaj ' +
        'apogpunktoj kun interspaco de ' +
        (b.meta.stepMs / RE.MINUTE).toFixed(3).replace('.', ',') + ' minutoj.',

      'La 39-komponanta listo estis esplorita por maksimumaj kaj minimumaj ' +
        'akvoniveloj. Ghia uzo por la tuta kurbo chi tie estas kombino kun la ' +
        'kurba metodo priskribita en BSH 50/2013.'
    );

    const analysisStart = Date.parse(b.meta.analysisStartUTC);
    const analysisEnd = Date.parse(b.meta.analysisEndUTCExclusive);

    if (start < analysisStart || start + RE.DAY > analysisEnd) {
      warnings.push(
        'La elektita tago estas almenau parte ekster la analiza periodo: ekstrapolo.'
      );
    }

    if (time > analysisEnd + 365.2425 * RE.DAY) {
      warnings.push(
        'La elektita momento estas pli ol unu jaron post la analiza periodo. ' +
        'La tajda reghimo kaj la meza akvonivelo povis shanghighi.'
      );
    }

  } else {
    warnings.push(
      'La modelo por akvoniveloj je arbitraj horoj ankorau ne estas preta. ' +
      'La administranto devas importi la modelojn post la fino de la analizo.'
    );

    // Ohne Ganglinie die Analysezeiträume der Scheitelmodelle prüfen.
    if (b.peaks.some(m =>
      start < Date.parse(m.inputStartUTC) ||
      start + RE.DAY > Date.parse(m.inputEndUTC)
    )) {
      warnings.push(
        'La elektita tago estas almenau parte ekster la analiza periodo ' +
        'de almenau unu modelo por maksimumaj kaj minimumaj akvoniveloj: ekstrapolo.'
      );
    }

    if (b.peaks.some(m =>
      time > Date.parse(m.inputEndUTC) + 365.2425 * RE.DAY
    )) {
      warnings.push(
        'La elektita momento estas pli ol unu jaron post la fino de ' +
        'almenau unu analizita serio de maksimumaj kaj minimumaj akvoniveloj. ' +
        'La tajda reghimo kaj la meza akvonivelo povis shanghighi.'
      );
    }
  }

  if (events.some(e => {
    const m = b.peaks[e.k - 1];
    return e.n < m.nMin || e.n > m.nMax;
  })) {
    warnings.push(
      'Almenau unu maksimumo au minimumo estas ekster la propra ' +
      'analizita transitintervalo de sia modelo.'
    );
  }

  if (b.curveReady) {
    const position = (time - b.meta.originMs) / b.meta.stepMs;
    const left = Math.floor(position);

    if ([left, left + 1].some(j => {
      const n = Math.floor(j / b.meta.points);
      const index = j - n * b.meta.points;
      const m = b.curves[index];
      return n < m.nMin || n > m.nMax;
    })) {
      warnings.push(
        'Almenau unu uzata kurba apogpunkto estas ekster sia propra ' +
        'analizita transitintervalo.'
      );
    }
  }

  // Bei einem Teilimport ist b.curves leer.
  const all = b.peaks.concat(b.curves);
  const counts = all.map(m => m.terms.length);
  const minimum = Math.min.apply(null, counts);
  const maximum = Math.max.apply(null, counts);

  if (minimum < 39) {
    warnings.push(
      'Ne chiuj modeloj uzas ĉiujn 39 komponantojn. ' +
      'La nombro varias de ' + minimum + ' ghis ' + maximum + '.'
    );
  }

  const shortestYears = Math.min.apply(null, all.map(m =>
    (m.nMax - m.nMin) * RE.MOON_DAY_HOURS / (24 * 365.2425)
  ));

  if (shortestYears < 9) {
    warnings.push(
      'Almenau unu modelo kovras malpli ol nau jarojn. ' +
      'Gravaj proksimaj frekvencoj ne estas aparte determineblaj.'
    );
  } else if (shortestYears < 18.6133) {
    warnings.push(
      'Almenau unu modelo ne kovras tutan lunan nodperiodon.'
    );
  }

  if (b.curveReady) {
    const coverage = Math.min.apply(null, b.curves.map(m =>
      m.availableCount / (b.meta.nLast - b.meta.nFirst + 1)
    ));

    if (coverage < 0.6) {
      warnings.push(
        'Almenau unu kurba apogpunkta serio enhavas malpli ol 60 procentojn ' +
        'da la eblaj observoj.'
      );
    }
  }

  if (!events.length) {
    warnings.push('Neniu maksimumo au minimumo estis trovita por la elektita tago.');
  }

  for (let i = 1; i < events.length; i++) {
    if (events[i].high === events[i - 1].high) {
      warnings.push(
        'La sinsekvo de maksimumoj kaj minimumoj ne alternas. ' +
        'La modeloj bezonas kontrolon.'
      );
      break;
    }
  }

  return Array.from(new Set(warnings));
}

/* ============================================================
 * Datum, Uhrzeit, Formatierung
 * ============================================================ */

function reParseInput_(dato, horo) {
  if (
    typeof dato !== 'string' ||
    typeof horo !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dato) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(horo)
  ) {
    reFail_('Bonvolu elekti validajn daton kaj horon en UTK.');
  }

  const year = Number(dato.slice(0, 4));

  if (year < RE.MIN_YEAR || year > RE.MAX_YEAR) {
    reFail_('Elektu jaron de ' + RE.MIN_YEAR + ' ghis ' + RE.MAX_YEAR + '.');
  }

  const canonical = dato + 'T' + horo + ':00.000Z';
  const time = Date.parse(canonical);

  if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) {
    reFail_('La elektita dato au horo ne estas valida.');
  }

  return time;
}

function reNumber_(value) {
  if (!Number.isFinite(value)) throw new Error('Ungültiger Ausgabewert.');

  const text = value.toFixed(RE.DECIMALS);
  return (Number(text) === 0
    ? (0).toFixed(RE.DECIMALS)
    : text
  ).replace('.', ',');
}

function reDisplayTime_(time) {
  const rounded = Math.round(time / RE.MINUTE) * RE.MINUTE;

  return new Date(rounded).toISOString()
    .slice(0, 16).replace('T', ' ') + ' UTK';
}

function reFail_(message) {
  const error = new Error(message);
  error.eo = true;
  throw error;
}

/* ============================================================
 * Manueller Synthesetest
 * ============================================================ */

function testiModelojn_() {
  const bundle = reLoadBundle_();

  const start = bundle.curveReady
    ? Date.parse(bundle.meta.analysisStartUTC)
    : Date.parse(bundle.peaks[0].inputStartUTC);

  const end = bundle.curveReady
    ? Date.parse(bundle.meta.analysisEndUTCExclusive)
    : Date.parse(bundle.peaks[0].inputEndUTC);

  const middle = Math.floor((start + end) / (2 * RE.MINUTE)) * RE.MINUTE;

  const text = new Date(middle).toISOString();
  const result = kalkuli(text.slice(0, 10), text.slice(11, 16));

  if (!result.ok) throw new Error(result.mesagho);

  if (!bundle.curveReady) {
    if (result.kurboPreta !== false || result.nivelo !== null) {
      throw new Error(
        'Teilimport-Test fehlgeschlagen: Ganglinie darf noch nicht verfügbar sein.'
      );
    }

    console.log(JSON.stringify(result, null, 2));
    console.log(
      'Modellvalidierung und Scheitelpunkt-Synthesetest bestanden. ' +
      'Stützstellentest übersprungen: Ganglinie noch nicht freigegeben.'
    );
    return true;
  }

  // Stützstellen und direkte Synthese müssen übereinstimmen.
  const n = Math.floor(
    ((start + end) / 2 - bundle.meta.originMs) / bundle.meta.moonDayMs
  );

  for (const k of [1, Math.floor(bundle.meta.points / 2), bundle.meta.points]) {
    const time = bundle.meta.originMs +
      n * bundle.meta.moonDayMs +
      (k - 1) * bundle.meta.stepMs;

    const direct = reEvaluate_(
      n, bundle.curves[k - 1].terms, bundle.curves[k - 1].height
    );
    const interpolated = reCurveValue_(time, bundle);

    if (Math.abs(direct - interpolated) > 1e-7) {
      throw new Error('Stützstellentest fehlgeschlagen, k=' + k);
    }
  }

  console.log(JSON.stringify(result, null, 2));
  console.log('Modellvalidierung und Stützstellentest bestanden.');
  return true;
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
