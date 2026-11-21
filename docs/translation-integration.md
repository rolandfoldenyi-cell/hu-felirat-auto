# Fordítási rész – együttműködés Claude Android-változatával

Ez a változás kizárólag a meglévő felirat magyarra fordítását és a megjelenítést javítja. A feliratkinyerés, az `android/` mappa, a `public/caption-core.js` és a `public/native-bridge.js` Claude feladata. Ezeket ez a PR nem módosítja, és nem másolja át a korábbi kísérleti Codex Android-ágról.

## Csatlakozási pont

A `public/app.js` jelenlegi betöltője a feliratlekérés után ilyen adatokat alakít a lejátszó belső modelljére:

```js
// A meglévő caption-válasz feliratsora. Az idők másodpercben értendők.
{ start: 1.25, end: 3.5, text: 'This is an English sentence.' }

// A lejátszó és a fordító belső feliratsora.
{ start: 1.25, end: 3.5, original: 'This is an English sentence.', translated: null }
```

A natív feliratlekérés bekötése után ugyanaz a `translateAllProgressive(signal, sourceLangName)` futtatható. A fordítási kód nem ismeri a natív híd nevét vagy protokollját; nem feltételez új exportot Claude fájljaiban. Az új `translateTimedCues` másik adapterből is hívható:

```js
import { createTranslationCache, translateTimedCues } from '/timed-translation.js';

const result = await translateTimedCues(cues, {
  sourceLanguage: 'en',
  signal,
  cache: createTranslationCache(),
  translate: (texts, signal) => freeTranslator(texts, signal),
  onUpdate: ({ updates, completed, total, failed }) => {
    // updates: [{ index, translated }]; a null eredmény sikertelen fordítás.
    // A pozíciókat az eredeti cues tömbhöz kell párosítani.
  }
});
```

A `freeTranslator` válasza az eredeti sorrendhez igazodik:

```js
{
  translations: ['Ez egy angol mondat.', 'Untranslated English sentence.'],
  failed: 1,
  failedIndices: [1],
  engine: 'google_free',
  engines: ['google_free']
}
```

A meglévő `translateByPriority` most már a sikertelen sorok indexeit is visszaadja. A helytelen hosszúságú vagy hibásan azonosított választ a fordító nem rendeli találgatással a felirathoz.

## Viselkedés

- A kezdési és befejezési idő, a sorazonosító és az angol forrásszöveg változatlan marad.
- Azonos szöveget egy feldolgozáson belül egyszer fordítunk, majd az eredményt az összes megfelelő időponthoz hozzárendeljük.
- A sikeres eredményeket forrásnyelv és szöveg alapján legfeljebb 30 napig tároljuk helyben, korlátozott méretű gyorsítótárban. API-kulcs nem kerül ebbe a gyorsítótárba.
- A tárhely letiltása vagy megtelése nem akadályozza a fordítást.
- Sikertelen fordítás esetén `translated: null` marad, és a felület eredeti nyelvűként jelöli a sort. A videó szinkronizációja továbbra is az eredeti időkkel működik.
- A „↻ Újra” részleges hiba után csak a hiányzó sorokat kéri le. Ha minden sor kész, a gomb új fordítást kér és frissíti a mentést. A Chrome bekapcsolása szintén új fordítást kér.
- Új videó betöltésekor a korábbi feladatot meg kell szakítani. Későn visszaérő fordítás nem frissítheti az új videót.
- Az alap fordítási sorrend változatlan: támogatott Chrome-fordító, ingyenes Google, opcionálisan megadott DeepL. Supadata nem része a fordítási láncnak.

## Ellenőrzés és határ

```sh
node --test tests/*.test.mjs
node --check public/app.js
```

24 automatizált ellenőrzés fedi többek között az időzítések megtartását, az ismételt sorokat, a mentés újraolvasását, a részleges hibát és újrapróbálást, a hibás sorpárosítást, a megszakítást és a valódi frontend vezérlését szimulált hálózati válaszokkal.

Ezek nem igazolják a valós YouTube-letöltést. A teljes elfogadási próbát Claude feliratkinyerőjének bekötése után kell elvégezni valós videóval és telefonon: egy link → angol időzített felirat → ingyenes magyar fordítás → szinkron lejátszás. A jelenlegi PR önmagában nem szünteti meg a Vercelről érkező YouTube-kérések blokkolását.
