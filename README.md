## Setup
Node installieren: https://nodejs.org  
`npm i npm -g`  
`npm i` (in den Projekten jul-compiler, jul-language-server, vscode-jul-language-service)  
`npm i copyfiles -g`  
`npm i rimraf -g`  
`npm i @vscode/vsce -g`

Damit vsce ausgeführt werden kann:  
Admin PowerShell öffnen  
`Set-ExecutionPolicy -ExecutionPolicy Unrestricted`

## Build
Maßgeblich sind die Skripte in der `package.json` — die folgende Beschreibung erklärt nur,
was sie tun.

`npm run build`  
Baut nur den Compiler: `out` leeren, `tsc -p tsconfig.build.json`, `core-lib.jul` nach `out` kopieren.

`npm run build-all`  
Baut zusätzlich die beiden abhängigen Projekte, jeweils über ihre eigene tsconfig:
1. jul-compiler: `npm run build`
2. jul-language-server: `npx tsc --project ../jul-language-server/tsconfig.build.json`
3. vscode-jul-language-service: `npx tsc --project ../vscode-jul-language-service/tsconfig.json`

Der Language Server importiert die **kompilierten** Artefakte aus `jul-compiler/out`,
Compiler-Änderungen wirken dort also erst nach einem Build.

`npm run build-all-and-deploy`  
`build-all` + CLI global installieren + vsix bauen und in VSCode installieren. Dabei kopiert
`test-deploy` (in vscode-jul-language-service) auch die `node_modules` ins Extension-Verzeichnis —
nur so findet die installierte Extension den Server.

## Cli installieren
`npm i -g` (bzw. `npm run install-cli`)

## Cli ausführen
Argument ist die **Config**, nicht die Quelldatei:

```bash
cd ../jul-examples/fizz-buzz
jul jul-config.yaml                        # nach install-cli
node ../../jul-compiler/out/cli.js jul-config.yaml
node out/bundle.js                         # Ergebnis ausführen
```

`--check` (vor oder nach der Config) parst und checkt nur, ohne zu emittieren oder zu bundeln —
es entsteht kein `out`-Ordner:

```bash
jul jul-config.yaml --check
```

## Test
`npm test`  
Mocha über `src/**/*.test.ts`, via tsx — kein Build nötig.

Einzelne Testdatei bzw. einzelnen Test (`-g` sucht im `it(...)`-Text):

```bash
npx mocha --import=tsx --require ./test-setup.mjs src/checker/checker.test.ts
npx mocha --import=tsx --require ./test-setup.mjs "src/**/*.test.ts" -g pattern
```

`npm run test-update-snapshot` schreibt die Baselines unter `src/checker/` neu — die Änderung
daran ist anzusehen, nicht blind zu übernehmen.

`npm run typecheck` prüft Quellen und Tests ohne Emit.

Zum Bench (`npm run bench`) siehe [../CLAUDE.md](../CLAUDE.md).

## Publish
`npm run build`  
`npm version patch` (oder minor/major)  
commit  
`npm publish`
