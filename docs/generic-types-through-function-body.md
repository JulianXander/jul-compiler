# Warum generische Praezision an der Funktionsgrenze eine Annotation braucht

Fund (2026-09-12): `myConcat = (a: List(Any) b: List(Any)) => [...a ...b]` verlor die Tuple-
Arität ihrer Argumente, obwohl `Concat` diese Arität in einer Rückgabetyp-Annotation exakt
berechnen kann (`:> Concat(TypeOf(a) TypeOf(b))`). Kein Bug - Spread im Rumpf war nur einer von
mehreren Orten, an denen der Checker eine Parameter-Referenz *eager* auf ihren deklarierten Typ
zurückfaltete, statt sie fuer die spaetere Aufrufstelle symbolisch zu halten. Fuer Spread
umgesetzt (siehe "Stand" unten); die uebrigen Stellen sind Kandidaten fuer spaeter.

## Warum das passiert(e)

`a` ist im Funktionsrumpf technisch bereits ein `parameterReference` (derselbe Platzhalter-Typ wie
in einer Rückgabetyp-Annotation) - der Unterschied liegt an der Auflösungsfunktion, nicht am
Platzhalter selbst:

- Rückgabetyp-Annotationen werden mit `dereferenceArgumentTypesNested` aufgelöst: diese Funktion
  bekommt die konkreten Argumenttypen DIESES Aufrufs und ersetzt die Parameter-Referenz damit.
- Ausdrücke im Funktionsrumpf werden mit `resolvePlaceholders` aufgelöst: diese Funktion kennt
  keinen Aufrufkontext (der Rumpf wird nur EINMAL bei der Deklaration geprüft) und fällt daher auf
  den *deklarierten* Parametertyp zurück (`List(Any)`).

Das betrifft nicht nur Spread. Mindestens vier unabhängige Stellen in `checker.ts` zeigten dasselbe
Muster:

1. Präfix-Argument eines Methodenaufrufs (`values.getElement(2)`) - **offen**
2. Index-/Namenszugriff (`values/2`) - **offen**
3. List-Spread im Literal, `[...a x]` gemischt mit normalen Elementen - **umgesetzt**
4. "Reiner" Spread ohne normale Elemente (`[...a ...b]`) - eigener Parse-Knoten `object.type`
   (`ParseUnknownObjectLiteral`, siehe CLAUDE.md), nicht `list` - **umgesetzt**

Eine Lösung nur für Spread waere deshalb eine neue, willkürliche Ausnahme (Verstoß gegen
Einheitlichkeit, design-principles.md) - "Spread ist schlau, Feldzugriff nicht" hat keine
erkennbare Logik.

## Wie andere Sprachen das lösen

- **TypeScript (generische Funktionen, variadic tuple types seit 4.0)**: `function concat<T extends
  unknown[], U extends unknown[]>(a: [...T], b: [...U]) { return [...a, ...b]; }` - TS leitet den
  Rückgabetyp `[...T, ...U]` automatisch aus dem Rumpf ab, **ohne** dass er explizit annotiert
  werden muss. Möglich, weil TS generische Typparameter (`T`, `U`) durchgängig symbolisch durch
  die GESAMTE Rumpfprüfung trägt - nicht nur an einer Signatur-Position wie JULs
  `ParameterReference`. Jede Operation im Checker (Spread, Indexierung, Property-Zugriff) kennt
  ihre eigene "generische Form" und bleibt symbolisch, bis der Aufruf konkrete Typen einsetzt.
  Genau das fehlt JUL an den vier oben genannten Stellen: dort wird der Platzhalter vorzeitig
  aufgelöst, statt ihn wie TS bis zur Aufrufstelle durchzureichen.
- **Rust (const generics)**: `fn concat<const N: usize, const M: usize>(a: [i32; N], b: [i32; M])
  -> [i32; N + M]` - die Länge im Rückgabetyp (`N + M`) muss weiterhin **explizit** annotiert
  werden; Rust leitet Arithmetik über const generics nicht automatisch aus dem Rumpf ab (auf
  stable bis heute nicht möglich, `generic_const_exprs` ist seit Jahren unstable). Selbst eine
  Sprache mit ausgereiften const generics loest also nicht automatisch her - dieselbe Grenze wie
  JULs aktueller Stand.
- **Haskell (Type Families, GHC.TypeLits)**: `type family Concat (a :: [k]) (b :: [k]) :: [k]`
  wird als eigene, zum Term-Code parallele Typebene-Gleichung geschrieben - strukturell identisch
  zu JULs Konstruktoren (`Concat`, `ElementAt`, ...). Auch hier keine automatische Herleitung aus
  dem Term-Rumpf; die Typebene bleibt eine eigene, explizit deklarierte Sprache.
- **Idris/Agda (volle dependent types)**: Typen und Terme leben in derselben Sprache und Ebene;
  der Rückgabetyp `Vect (n + m) a` kann buchstäblich dieselbe `append`-Funktion referenzieren, die
  auch zur Laufzeit läuft - der Type-Checker normalisiert (evaluiert) Terme waehrend der Prüfung.
  Das ist der einzige Ansatz, der wirklich ohne jede Parallel-Algebra auskommt - erkauft mit
  Terminierungspflicht (Totalitätsprüfung) und potenziell teurer Normalisierung waehrend jeder
  Typprüfung.
- **Zig (`comptime`)**: kein separates Typsystem für Längen/Formen - Compile-Time-Code ist
  identisch zur Laufzeit-Sprache, nur zu einem früheren Zeitpunkt ausgeführt. Näher an JULs eigener
  Prämisse ("Werte und Typen leben im selben Namensraum") als jede der obigen Sprachen. Konsequent
  zu Ende gedacht waere JULs naheliegendste Variante nicht "noch mehr symbolische Konstruktoren",
  sondern: den Funktionsrumpf bei bekannten (literalen) Argumentlängen tatsächlich auszuwerten,
  statt ihn zu falten - was praktisch wieder auf denselben Mechanismus hinausläuft, den
  `dereferenceArgumentTypesNested` pro Aufruf schon macht, nur als Zwischenschritt fuer die
  BODY-Ausdrücke selbst statt nur fuer die Rückgabetyp-Annotation.

## Umgesetzt fuer Spread (2026-09-12)

Beide Spread-Faelle (`case 'list'` und `case 'object'` in `inferType`) pruefen jetzt vor dem
eigentlichen Zusammensetzen, ob eine Spread-Quelle noch `isUnresolvedPlaceholderType` ist. Ist das
so, wird `concatFromTypes` mit den unaufgeloesten Quell-Typen aufgerufen statt sofort konkret zu
falten - das liefert denselben `Concat`-Knoten, den auch eine explizite Annotation erzeugen wuerde,
und er wird am Aufrufort ganz normal ueber `dereferenceArgumentTypesNested` aufgeloest. Kein neuer
Mechanismus noetig, nur die vorhandene Faltung an einer weiteren Stelle ausgeloest.

Zwei Nebenfunde dabei, unabhaengig vom eigentlichen Thema:
- `resolvePlaceholders` hatte keinen `case 'greater'`, obwohl `CompileTimeGreaterType` ein
  verschachteltes `Value` traegt (`dereferenceArgumentTypesNested` und `isUnresolvedPlaceholderType`
  hatten ihn bereits) - nachgezogen.
- `resolvePlaceholders`s `default: return rawType` wurde durch einen exhaustiven Switch mit
  explizitem `assertNever` ersetzt (Blatt-Typen fallen weiterhin ohne Aenderung durch) - genau ein
  solcher fehlender Fall waere damit ein Compile-Fehler statt eines stillen Bugs gewesen.

Gemessen (yugioh, 5800 Zeilen): Zeit -1% (Rauschen), `resolvePlaceholders` +3,8%,
`getTypeError` +1,2% - deutlich unter der Schwelle, ab der es aufwendiger untersucht werden muesste
(vgl. den `+51%`-Fund bei `WithElementAt` oben in derselben Datei). 261 -> 262 Tests, keine
Regression; drei zuvor gruene Tests (`list-literal-spread-collapses-to-list`,
`possibly-empty-list-spread-collapses-to-list`, `tuple-literal-spread-flattens-elements`) lesen
den Funktions-Rueckgabetyp jetzt ueber `resolvePlaceholders` statt roh, weil er intern ein
aufschiebbarer `Concat`-Knoten sein kann.

## Offen: Praefix-Argument und Index-/Namenszugriff

Dieselbe Umstellung (vor `resolvePlaceholders` erst `isUnresolvedPlaceholderType` pruefen, dann
den passenden Konstruktor statt sofortiger Faltung) waere fuer die beiden verbleibenden Stellen
grundsaetzlich genauso moeglich:

1. `dereferenceArgumentTypesNested` existiert schon und kann den Platzhalter am Aufrufort
   auflösen - der fehlende Teil ist nur, das *innerhalb* der Rumpfprüfung ebenfalls zu verwenden,
   statt es auf die Rückgabetyp-Dereferenzierung zu beschränken.
2. Der zuletzt behobene Bug (Rückgabetyp faellt auf den Rumpf-Typ zurueck, sobald der nicht
   exakt `Any` ist) muesste sinngemaess auch fuer Zwischenwerte gelten, nicht nur fuer den
   letzten Ausdruck des Rumpfs.
3. Die verbleibenden zwei Fundstellen muessten einheitlich umgestellt werden, sonst bleibt eine
   willkuerliche Grenze stehen (Spread generisch, `getElement`/Feldzugriff nicht).

## Tradeoffs

- **Performance, real gemessen, nicht geschaetzt.** Ein einziger zusaetzlicher aufschiebbarer
  Knotentyp (`WithElementAt`) hat `getTypeError` um +51% auf einer 5800-Zeilen-Codebasis erhoeht
  (docs/CHECKER-AUDIT.md, TODO). Wuerde JEDE Parameterverwendung im Rumpf potenziell symbolisch
  bleiben (nicht nur die eine, explizit annotierte Stelle), waere die Reichweite dieser Kosten
  ungleich groesser: nicht mehr auf die Funktionen begrenzt, die der Nutzer bewusst annotiert hat,
  sondern auf jede Funktion, deren Rumpf ueberhaupt einen Parameter beruehrt.
- **Stillschweigend wechselnde Praezision als API-Leck.** Wenn der Rückgabetyp automatisch aus der
  Rumpf-Implementierung folgt, aendert eine harmlose interne Umformulierung des Rumpfs (z.B.
  `[...a ...b]` zu `concat(a b)` mit einer Hilfsfunktion) leise die Praezision, die Aufrufer sehen
  - ganz ohne Signaturaenderung. TypeScript kennt dasselbe Problem bei oeffentlichen APIs (daher
  Style-Guides und Linter-Regeln, die explizite Rückgabetypen an Modulgrenzen erzwingen). Die
  explizite Annotation ist in JUL bereits der Ort, an dem diese Zusicherung sichtbar unabhaengig
  von der Implementierung steht - das spricht dafuer, automatische Herleitung hoechstens als
  zusaetzliche, nicht ersetzende Praezisierung zuzulassen, nie als Verzicht auf die Annotation bei
  oeffentlichen Funktionen.
- **Einheitlichkeit** gilt jetzt fuer Spread; die verbleibenden zwei Stellen (Praefix-Argument,
  Index-/Namenszugriff) sind eine eigene, kleinere Entscheidung - dieselbe Abwaegung wie oben,
  diesmal ohne dass Spread noch als Gegenbeispiel dient.
- **Kein neues Typsystem noetig.** Anders als die anfaengliche Vermutung ("das waere general
  dependent typing") braucht dieser Weg keine neue Typmaechtigkeit - nur dieselben sechs bereits
  gebauten Konstruktoren (`Concat`, `ElementAt`, `LengthOf`, `WithElementAt`, `Range`, `TupleOf`)
  an vier zusaetzlichen Stellen ausloesen zu lassen, statt nur an der Rückgabetyp-Annotation.

## Bewertung

Kein akuter Leidensdruck (siehe TODO) - die explizite Annotation ist ein Vier-bis-Fuenfzeichen-
Mehraufwand pro generischer Funktion und funktioniert schon heute korrekt. Lohnt sich erst, wenn
mehrfach beobachtet wird, dass Nutzer die Annotation vergessen und sich stillschweigend ueber
verlorene Praezision wundern - dann mit Messung wie beim WithElementAt-Fund (Einzeldurchlauf,
Zaehler vorher/nachher unter einer Harness), nicht aus dem Bauch heraus.
