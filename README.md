## Setup
`npm i` (in den Projekten jul-compiler, jul-language-server, vscode-jul-language-service)  
`npm i copyfiles -g`  
`npm i rimraf -g`

## Build
`npm run build-all`  
Baut jul-compiler, jul-language-server und vscode-jul-language-server
1. jul-compiler: `npx tsc && copyfiles --flat src/core-lib.jul out`
2. jul-language-server: `npx tsc --project ../jul-language-server/tsconfig.json`
3. vscode-jul-language-service: 
    1. delete:	`rimraf ../vscode-jul-language-service/out/jul-language-server`
    2. copy:	`copyfiles -a ../jul-language-server ../vscode-jul-language-service/out --exclude .git`
    3. build:   `npx tsc`

## Cli installieren
`npm i -g`

## Cli ausführen
`jul ../jul-examples/test1.jul`  
`npx ts-node src/cli.ts ../jul-examples/test1.jul`