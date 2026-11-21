# HU Felirat Auto – Android tesztváltozat

Ez az app a telefon saját hálózatáról kéri le a YouTube-on már meglévő feliratot a NewPipeExtractor 0.27.1 könyvtárral. A meglévő webes felületet csomagolja az APK-ba. A kinyert WebVTT időzítéseit helyben olvassa be, majd a meglévő ingyenes Chrome/Google fordítási lánc végzi a magyar fordítást.

A telefonon elég a linket bemásolni és a Betöltés gombra nyomni. A feliratletöltés és a fordítás automatikusan indul. Ez nem hangfelismerő: felirat nélküli videóhoz nem állít elő új átiratot.

## Állapot és ellenőrzés

Fejlesztői tesztváltozat, nem igazolt végleges megoldás. Az automatizált ellenőrzések nem bizonyítják, hogy a YouTube Roland telefonjának hálózatáról kiadja a feliratot. Ezt az APK telepítése után kell valós videóval kipróbálni. A telefon hálózatát is blokkolhatja a YouTube; ezt külön hibaüzenet jelzi. Nincs automatikus Supadata-hívás vagy fizetős AI.

Az app verziója: 2.1.0-test1. A telepített PWA ettől külön alkalmazás; az Android-ikonról kell megnyitni az új tesztváltozatot.

## Build

JDK 17, Gradle 8.11.1, Android SDK 35 szükséges. Az Android Gradle Plugin 8.9.2. A GitHub Actions munkafolyamat ezeket a megfelelő Ubuntu runneren használja, majd feltölti az APK-t és az ellenőrzések jelentéseit.

```sh
node --test tests/*.test.mjs
cd android
gradle testDebugUnitTest lintDebug assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`. GitHub Actions: a repository Actions lapján az „Android test APK” futás `HU-Felirat-Auto-Android` melléklete tartalmazza. A checksum ugyanott `SHA256SUMS.txt` néven található.

A teszt-APK a buildkörnyezet debug kulcsával készül. Másik buildből származó tesztváltozat frissítésénél újratelepítésre lehet szükség; a stabil, saját kulccsal aláírt kiadás külön kiadási lépés.

## Valós telefonos próba

1. Telepítsd és nyisd meg a HU Felirat Auto Android-változatát. Ellenőrizd az `ANDROID · 2.1.0-test1` feliratot.
2. Másolj be egy ismerten angol feliratos videólinket. Ne adj meg API-kulcsot.
3. Ellenőrizd a telefonos letöltés, a magyar fordítás és a kész állapot megjelenését.
4. Indítsd el a videót, tekerj előre és vissza. A magyar feliratnak a beszéd időzítését kell követnie.
5. Ismételd meg automatikus angol feliratos videóval. Rögzítsd a linket, a telefon típusát, az Android/WebView verzióját és a hibaszöveget, ha van.

## Hozzáférések és licencek

Csak INTERNET engedély szükséges. A natív feliratkinyerőhöz kizárólag a saját HTTPS appoldal fő kerete fér hozzá; a YouTube iframe nem. A letöltő nem használ WebView-cookie-kat vagy YouTube-fiókot, csak engedélyezett HTTPS YouTube/Google végpontokat kér le. A statikus appfájlok az APK-ból érkeznek, a meglévő opcionális `/api/translate` háttérszolgáltatás a helyes Vercel-domainen marad.

A NewPipeExtractor és az új Android-modul GPL-3.0-or-later licencű. A licenc szövege az `android/LICENSE` fájlban található. Az appal átadott forrás és a buildleírás elérhető ugyanabban a repositoryban a `codex/android-caption-pipeline` ágon. A meglévő frontend szerzői jogi jelöléseit megőrizzük. Az Android-kiadás további terjesztésekor a függőségek és az összekapcsolt alkalmazás licencfeltételeit is meg kell őrizni.

Upstream: https://github.com/TeamNewPipe/NewPipeExtractor/tree/v0.27.1
