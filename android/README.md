# HU Felirat – Codex 2 (2.2.0-test3)

Önálló, teljesen automatikus Android-tesztváltozat. A YouTube-link betöltése után az app először a meglévő angol feliratot kéri le. Ha a videóhoz nincs feliratsáv, automatikusan megpróbálja letölteni a hangsávot, és a telefonon futó Whisperrel időzített angol szöveget készít. Ezt a meglévő ingyenes fordítási lánc magyarra fordítja, majd a lejátszó az időzítések alapján jeleníti meg.

A feldolgozás az appon belül marad; nem kell kézzel másolni vagy feliratfájlt kezelni. A modell az APK része, az alapfolyamathoz nincs szükség fiókra, mikrofonengedélyre vagy API-kulcsra. A hangot nem küldjük felhős beszédfelismerőnek. A felismert szöveg fordítása a támogatott Chrome-fordítóval, illetve az ingyenes Google-lánccal történik; a korábban külön megadott DeepL-kulcs opcionális.

## Fekvő és teljes képernyős nézet

A videó és a magyar felirat egy közös nézetben marad. Teljes képernyőn az Android-konténer nem ad külön bal vagy alsó térközt, és a webes lejátszó sem tolja el a videót a kamerakivágás miatt. A kép a teljes ablak közepére igazodik; a felirat szövege és a kilépőgomb kap védőtérközt. A normál nézetben az Android egyszer alkalmazza és elfogyasztja az inseteket. Fekvő telefonon automatikusan kibővül a lejátszó; a felirat a videó alatt külön sávot kap. Az app ⛶ gombja ugyanezt a nézetet nyitja meg. A Kilépés gomb és az Android Vissza gomb visszavisz a normál felületre. Forgatáskor nem töltjük újra az oldalt vagy a videót. A YouTube külön, csak a videót mutató teljesképernyő-gombja helyett az app gombját használjuk.

## Használat és korlátok

1. Telepítsd és indítsd el a **HU Felirat – Codex 2** alkalmazást.
2. Másold be a YouTube-linket és indítsd a betöltést.
3. Várd meg a kész állapotot. Felirat nélküli videónál a hangsáv feldolgozása hosszabb ideig tarthat; a felület jelzi az aktuális lépést.
4. Indítsd el a videót. Az angol és a magyar szöveg ugyanahhoz az időzítéshez tartozik.

A beszédfelismerés angol hangra készült, automatikus eredménye hibákat tartalmazhat. Ebben a tesztverzióban legfeljebb 60 perces videót és 128 MiB letölthető hangot dolgoz fel. A képkockákra írt, nem kimondott szöveget nem ismeri fel. Ha a YouTube a hangsáv letöltését is megtiltja, a folyamat hozzáférési hibával leáll. A BABEL (RecF4T7KquQ) felirata a YouTube saját lejátszójában sem érhető el; az erről indított szerveres hangpróbát botellenőrzés blokkolta. A konkrét videóval a saját telefonos próba szükséges.

A korábbi Codex-app mellé is telepíthető: ennek a változatnak a csomagazonosítója hu.feliratauto.codexspeech. A modell körülbelül 33 MB, ezért az APK a korábbi verziónál nagyobb. A teszt-APK debug aláírású; későbbi tesztkiadásoknál újratelepítésre lehet szükség.

## Forrás és build

JDK 17, Gradle 8.11.1, Android SDK 35, NDK 27.0.12077973 és CMake 3.22.1 szükséges. A GitHub Actions a pontosan rögzített whisper.cpp d1be6fde11ac6e0407606b4e42fe72d34add8037 commitot használja. A modell-manifest a letöltési helyeket, méreteket és SHA-256 értékeket tartalmazza; minden modell ellenőrzés után kerül az APK-ba.

A whisper.cpp forrásának az android/third-party/whisper.cpp mappában kell lennie. Ezután a repository gyökeréből:

```sh
python3 android/prepare-asr-assets.py
node --test tests/*.test.mjs
cd android
gradle testDebugUnitTest lintDebug assembleDebug
```

Az előkészítőhöz ffmpeg szükséges a nyílt JFK hangminta AAC-tesztváltozatának elkészítéséhez. A modellfájlok és a harmadik fél forrása nem kerül a gitbe. Az Actions végzi az Android-emulátoros ellenőrzést, majd sikeres futás után közzéteszi az APK-t és az ellenőrzőösszeget. A szerver által blokkolt élő hálózati próba kihagyását nem tekintjük sikeres YouTube-letöltésnek.

## Adatkezelés és licencek

Csak INTERNET engedély szükséges. A natív képességhez kizárólag a saját appoldal fő kerete fér hozzá; a YouTube iframe nem. A letöltő nem használ YouTube-fiókot vagy személyes cookie-t. Az ideiglenes hangfájlokat a feldolgozás végén törli. A kész angol átirat legfeljebb hét napig az app saját gyorsítótárában maradhat; a sikeres fordítások legfeljebb 30 napig, korlátozott méretben tárolódnak.

Az Android-modul és a NewPipeExtractor GPL-3.0-or-later licencű. A Whisper.cpp, a Whisper-modellek és a Silero VAD licencei a licenses mappában, valamint az APK tájékoztatójában találhatók. A forrás és az összeállítás leírása ugyanebben a repositoryban érhető el.
