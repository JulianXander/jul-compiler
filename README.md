Build (npm run build):
1. jul-comiler: npx tsc src/runtime.ts && npx tsc
2. jul-language-server: npx tsc --project ../jul-language-server/tsconfig.json
3. vscode-jul-language-service: 
3.1 delete:	rm -r ../vscode-jul-language-service/out/jul-language-server
3.2 copy:	rsync -a ../jul-language-server ../vscode-jul-language-service/out --exclude .git

Cli ausführen:
npm run cli ../examples/test1.jul
npx ts-node src/cli.ts ../examples/test1.jul