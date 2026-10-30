# Ret-apo "Rechtenfleth: akvoniveloj" kaj Android-apo "Akvo"

Tiu chi GitHub-deponejo priskribas Guglo-Apoj-Skripto-projekton por neoficiala astronomia prognozo de
akvoniveloj en Rechtenfleth lau la harmona prezento de neegalajhoj (germane: "harmonische Darstellung der Ungleichheiten", angle: "harmonic representation of inequalities").

Ret-apo "[Rechtenfleth: akvoniveloj](https://script.google.com/a/~/macros/s/AKfycbw1p6S3LyNaRTIcSu4myv3SP-ZzSX302erglMDh8R9wwq1ZRAHCwJ8Nb9q5t-Isl0aX/exec)" kaj Android-apo "Akvo" (elshut-ligilo estas en la ret-apo-pagho) eligas la
akvonivelon por elektita momento kaj krome la tempojn kaj altojn de la
maksimumaj kaj minimumaj akvoniveloj de elektita tago.

Chiuj tempoj estas en UTK. Akvoniveloj
aperas en metroj.

## Kiel la projekto estighis

La bazo estas minutaj mezuroj de akvoniveloj en centimetroj,
devenantaj de **PEGELONLINE de la germana federacia administracio
pri akvovojoj kaj shipiro (WSV)**:

- [Staciaj datumoj de Rechtenfleth, numero 4970030](https://pegelonline.wsv.de/gast/stammdaten?pegelnr=4970030)

Por la analizo la mezuroj estis konservitaj en kvar
Guglo-kalkultabeloj por la periodoj 2007–2010, 2011–2015,
2016–2020 kaj 2021–2025. La ligita pagho priskribas la
mezurstacion; ghi ne estas rekta elshuta ligilo al la kvar
preparitaj kalkultabeloj.

La analizo kaj la ret-apo estas apartaj:

1. `analizo/hddu.gs` legas la mezurojn kaj rekonas maksimumojn
   kaj minimumojn. Kun Astronomy Engine ghi kalkulas verajn
   lunajn transirojn, por ordigi la okazajhojn en kvar klasojn.
2. Por chiu klaso ghi adaptas apartajn modelojn de tempo kaj
   alto per la metodo HDdU: harmona prezento de neegalajhoj.
   La 39 kandidataj frekvencoj estas donitaj en la kodo;
   el la mezuroj estas kalkulataj la koeficientoj, amplitudoj
   kaj fazoj. Lau la disponebla tempospaco povas esti uzataj
   malpli, ol 39 komponantoj.
3. Aldone ghi analizas la akvonivelan kurbon, ordinare kun
   96 apogpunktoj en chiu meza luna tago. Akvonivelo je
   arbitra minuto rezultas el la sintezo de tiuj modeloj kaj
   lineara interpolado, ne el nura kunligo de maksimumoj
   kaj minimumoj.
4. La analizo konservas modelojn kaj diagnozajn rezultojn
   en nova Google-kalkultabelo.
5. La ret-apo importas apartan kopion de la pretaj modeloj.
   Dum ordinara uzado ghi nek reanalizas la mezurojn nek
   bezonas Astronomy Engine.

La altoj en la tabelo de maksimumoj kaj minimumoj devenas de
la apartaj modeloj de tiuj okazajhoj. Ili ne nepre ekzakte
koincidas kun la ekstremoj de la interpolita akvonivela kurbo.

## Dosieroj kaj dependajho

```text
akvo/
├── README.md
├── analizo/
│   └── hddu.gs
└── retapo/
    ├── Code.gs
    └── index.html
└── aliaj_lokoj/
    └── brv/
        ├── analizo/
            └── hddu.gs
        └── retapo/
            ├── Code.gs
            └── index.html
```

- [`analizo/hddu.gs`](analizo/hddu.gs): analizo kaj kontrolaj
  prognozfunkcioj.
- [`retapo/Code.gs`](retapo/Code.gs): importo de modeloj kaj
  servilaj kalkuloj.
- [`retapo/index.html`](retapo/index.html): kalendaro, horelekto
  kaj montrado de rezultoj.   
- [`aliaj_lokoj/brv`](aliaj_lokoj/brv/): Analoge pri aliaj lokoj; aktuale nur pri Bremervörde (brv); tamen `aliaj_lokoj/brv/analizo/hddu.gs` kaj `aliaj_lokoj/brv/retapo/Code.gs` estas programitaj kun modifoj, nome
  kun konsidero je tio, ke tempajn brechojn havas la serio de mezuritaj akvoniveloj elshutitaj el [staciaj datumoj de Bremervörde, numero 5980010](https://pegelonline.wsv.de/gast/stammdaten?pegelnr=5980010);
  jen ret-apo "[Bremervörde: akvoniveloj](https://script.google.com/a/~/macros/s/AKfycbyEGdBNs6A7V9TTm5XicPGa8ai3B3m4iP-JBaY0D3NeoEbGWSdlFMU1NOlwwSgw3NK5/exec)".

La analizo uzas **Astronomy Engine 2.1.19** de Don Cross:

- [Originala projekto kaj dokumentado](https://github.com/cosinekitty/astronomy)
- [La uzita retumila versio 2.1.19: astronomy.browser.js](https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/astronomy.browser.js)

Kopiu la kompletan enhavon de tiu Java-dosiero en
dosieron `Astronomy.gs` de la analiza Apoj-Skripto-projekto.
Ghi disponigas la globalan objekton `Astronomy`.
Ne uzu nur fragmenton de la dosiero au la version destinitan
nur por Node.js.

Astronomy Engine havas MIT-licencon. Konservu ghiajn originalajn
kopirajtan kaj licencan tekstojn. Lauvole konservu la saman
kompletan dosieron ankau en la deponejo kiel
`analizo/Astronomy.gs`.

## Ripeti la analizon

Necesas Guglo-konto, Guglo-Tabeloj, Guglo-Apoj-Skripto kun
V8 kaj leg-aliro al la fontaj kalkultabeloj.

1. Kreu apartan Apoj-Skripto-projekton por la analizo kaj aldonu
   `hddu.gs` kaj la kompletan `Astronomy.gs` de versio 2.1.19.
2. Kontrolu `HD_SOURCES` en `hddu.gs`: identigilojn de
   kalkultabeloj, foliajn identigilojn (`gid`) kaj tempolimojn.
   Por propraj kopioj anstatauigu la identigilojn.
3. La mezuroj devas komencighi en `B2`. Chiu sekva vico
   reprezentas la sekvan minuton. La programo deduktas la
   tempon el la vicnumero kaj `firstUTC`, ne el aparta
   tempokolumno. Ne forigu vicojn kun mankantaj mezuroj.
   Registru konatajn nombrajn miskodojn en `HD.INVALID_LEVELS`.
4. Chiuj fontoj devas havi la saman mezurstacion, unuon kaj
   alto-referencon. La nuna ret-apo supozas centimetrojn
   kaj dividas la modelajn altojn per 100 por montri metrojn.
5. Rulu `testAstronomie()`, por kompari la lunajn transirojn
   kun la referencaj ekzemploj.
6. Rulu `hdduStart()` sen argumentoj kaj donu la petitajn
   permesojn. Ghi kreas novan rezultan kalkultabelon kaj
   tempan ekigilon por la posta prilaborado. La ligilo al
   la rezulto aperas en la plenuma protokolo.

La defaulte agordita analiza intervalo estas de
`2006-12-31T23:00:00Z` ghis `2025-12-31T23:00:00Z`,
kun la fino ekskluzivita.

Kontrolu la progreson per `hdduStatus()`. La analizo povas
dauri plurajn horojn au pli longe pro la kvotoj de Apoj-Skripto.
Post korekto de eraro au renovigo de la kvoto rulu
`hdduFortsetzen()`.

Dum la analizo ne shanghu fontojn au agordojn.
`hdduStop()` forigas la laborstaton kaj haltigas la ekigilon,
sed konservas la jam kreitan rezultan dosieron; ghi ne estas
nura pauzigo.

Atendu ghis la stato estas `DONE`, ankau en `Info!B6`.
Kontrolu precipe la foliojn `Quellen`, `Diagnostik` kaj
`Ganglinie_Diagnostik`: datumkovron, nombron de komponantoj
kaj erarojn de adaptado kaj tempa testo.

Poste eblas ruli:

- `beispielWasserstand20261014()` por unu akvonivelo;
- `beispielGanglinie20261014()` por taga serio;
- `beispiel20261103()` por maksimumoj kaj minimumoj.

Tiuj analizaj ekzemploj liveras altojn en la originala unuo
de la mezuroj, do en centimetroj por la uzitaj datumoj.
La konverto al metroj okazas en la ret-apo.

## Instali la ret-apon

1. Kreu alian Guglo-Tabelon kaj malfermu ghian ligitan
   Apoj-Skripto-projekton per la menuo de etendajhoj.
2. Aldonu nur `retapo/Code.gs` kaj `retapo/index.html`.
   En Apoj-Skripto la HTML-dosiero nomighu `index`.
   **Ne aldonu `hddu.gs` au Astronomy Engine al tiu projekto.**
   La analiza kodo kaj la kodo de la ret-apo havas samnomajn
   funkciojn kaj devas resti en apartaj projektoj.
3. En `Code.gs` agordu `RE.SOURCE_ID` al la identigilo de la
   rezulta kalkultabelo de la analizo, ne al unu el la
   mezuraj fontoj. Lasu `RE_MODEL = null`.
4. En la redaktilo rulu `importiModelojn()` kaj donu la
   petitajn permesojn. La funkcio kopias la modelojn en la
   novan kalkultabelon kaj konservas la referencon en la
   skriptaj atributoj.
5. Lauvole rulu `eksportiModelojn`. Ghi kreas tekstdosieron
   en Guglo-"Drive". Per ghia tuta enhavo anstatauigu
   `const RE_MODEL = null;` en `Code.gs`. Tiel la modeloj
   estas rekte enigitaj en la kodon kaj la prognozoj ne
   bezonas legi la modelan kalkultabelon.
6. Disponigu la projekton, kiel ret-apon, plenumatan kiel
   vi mem, kaj elektu la celitan alirgrupon. Malfermu la
   deplojan URL, elektu daton kaj horon kaj premu **Sendi**.

Por posta aktualigo ripetu la importon. Se `RE_MODEL` jam
enhavas modelojn, tiuj havas prioritaton: necesas ankau
anstatauigi ilin au revenigi la valoron al `null`.
Post kodaj shanghoj aktualigu la disponigon.

GitHub konservas la fontkodon; GitHub Pages ne povas rekte
plenumi tiun Apoj-Skripto-ret-apon.

## Reprodukteblo kaj fontoj

La fontkodaj dosieroj ne enhavas la mezurajn seriojn.
La identigiloj en `HD_SOURCES` ne garantias publikan aliron.
Por ripeti la originalan kalkulon necesas aliro al la samaj
mezuroj, la samaj agordoj kaj Astronomy Engine 2.1.19.
Sen la mezuroj au jam eksportita modelaro la fontkodo sola
ne liveras la originalajn prognozojn.

Por uzi au redistribui la mezurojn, kontrolu la aplikajn
uzkondichojn kaj fontindikajn postulojn de PEGELONLINE.
La MIT-licenco de Astronomy Engine ne estas licenco por
la mezuraj datumoj au automate por la cetera kodo.

La metodaj bazoj cititaj en `hddu.gs` estas:

- Müller-Navarra: *Berichte des BSH*, n-ro 50/2013, "Gezeitenvorausberechnung mit der Harmonischen Darstellung der Ungleichheiten (On Tidal Predictions by Means of Harmonic Representation of Inequalities)".
- Andreas Boesch / Sylvin Müller-Navarra: "Reassessment of long-period constituents for tidal predictions along
the German North Sea coast and its tidally influenced rivers" (2019).

La uzo de tiu komponantaro por la akvonivela kurbo estas
kombino de la du metodaj fontoj; ghi ne estas per si mem
validigo de tiu etendo.

## Gravaj limoj

**Ne temas pri oficiala prognozo au aktualaj mezuroj.**

- Vento, aerpremo kaj aktualaj riveraj alfluoj ne estas
  prognozataj.
- La alto-referenco restas tiu de la fontaj mezuroj;
  la konverto al metroj ne shanghas ghin.
- Du decimalaj lokoj kaj minuta tempa elekto ne garantias
  centimetran au minutan precizecon.
- Ekster la analizita periodo temas pri ekstrapolo.
  La elektebla jarintervalo 1900–2100 estas nur teknika
  limo, ne garantio pri valideco.
- Ne uzu la rezultojn, kiel solan bazon por navigado
  au sekurecaj decidoj.
