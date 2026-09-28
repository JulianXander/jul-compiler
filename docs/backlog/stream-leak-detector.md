# Leak-Detektor für Streams

Idee, keine Entscheidung. Ergänzung zur statischen Lebensdauer-Analyse aus
[stream-lifetimes.md](../stream-lifetimes.md), keine Alternative dazu.

## Was es wäre

Eine Prüfung zur Laufzeit im Entwicklungsmodus: Die Runtime zählt offene Quellen und die Listener
je Quelle. Wächst eine Zahl immer weiter, gibt sie eine Warnung aus, am besten mit dem Stack der
Stelle, an der die Streams entstehen.

Vorbilder:

- Node: `MaxListenersExceededWarning` ab mehr als 10 Listenern an einem EventEmitter.
- Android LeakCanary: prüft nach dem Schließen eines Screens, ob dessen Objekte noch erreichbar
  sind, und zeigt die festhaltende Referenzkette.
- React StrictMode: führt Effekte im Entwicklungsmodus doppelt aus, damit fehlendes Aufräumen
  auffällt.

## Was es fände

Genau das, was die statische Analyse bewusst nicht sieht:

- ein `complete` auf einem nie erreichten Pfad,
- Streams, die in Listen oder Dictionaries abgelegt werden,
- Streams, die über TS/JS-Importe hereinkommen,
- ein geglaubtes `~> FiniteStream(…)`, das nicht stimmt,
- ein `#jul-ignore`, das sich als falsch herausstellt.

## Was es kostet

- Laufzeit und Speicher, deshalb nur im Entwicklungsmodus. Den gibt es in JUL bisher nicht.
- Muss beim Runtime-Tree-Shaking vollständig wegfallen (`check-runtime-purity`).
- Eine Schwelle ist willkürlich, eine app-weite Quelle darf legitim viele Listener haben.
- Findet nur, was beim Ausprobieren tatsächlich passiert.

## Wann es sich lohnt

Erst wenn in echtem Code Leaks auftauchen, die die statische Analyse übersieht.
