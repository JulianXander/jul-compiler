import { use } from 'chai';
import chaiAsPromised from 'chai-as-promised';

use(chaiAsPromised);

// Mocha setzt das Limit auf Infinity, Node hat 10. Jedes Error-Objekt zeichnet dann den ganzen
// Stack auf, und das Constant Folding einer nicht terminierenden Rekursion läuft 1000 Ebenen tief -
// ein einzelner Test brauchte dadurch über 100 ms statt 5 ms. So laufen die Tests wie CLI und
// Language Server.
Error.stackTraceLimit = 10;

// Die Zugriffe auf das CheckResult prüfen, ob der Knoten zur Datei des Ergebnisses gehört (siehe
// checker/check-result.ts). Vor dem ersten Import des Checkers, der die core-lib beim Laden prüft.
process.env.JUL_VERIFY_NODE_OWNERSHIP = '1';
