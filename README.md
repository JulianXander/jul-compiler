Setup
npm i (in allen Projekten)
npm i copyfiles -g
npm i rimraf -g

Build (npm run build-all):
1. jul-comiler: npx tsc && copyfiles --flat src/core-lib.jul out
2. jul-language-server: npx tsc --project ../jul-language-server/tsconfig.json
3. vscode-jul-language-service: 
3.1 delete:	rimraf ../vscode-jul-language-service/out/jul-language-server
3.2 copy:	copyfiles -a ../jul-language-server ../vscode-jul-language-service/out --exclude .git

Cli ausführen:
npm run cli ../examples/test1.jul
npx ts-node src/cli.ts ../examples/test1.jul