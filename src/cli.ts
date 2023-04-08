#!/usr/bin/env node
import { compileFileToJs } from './compiler';

// console.log(process.argv)
const fileName = process.argv[2];
if (!fileName) throw new Error('No filename argument specified');
console.log(`compiling file ${fileName} ...`)

compileFileToJs(fileName)
