import assert from 'node:assert/strict';import fs from 'node:fs';import {QjsEngine} from '../src/engine.js';
const fixtures=[];
let source='';for(let i=0;i<64;i++)source+='/*😀é*/'.repeat(48)+`function f${i}(){return new Error('probe').stack;}`+(i%4===3?'\n':'');
fixtures.push(source+`globalThis.positionResults=[f0(),f1(),f5(),f31(),f63()];`);
const suffix=`function boundary(){return new Error('boundary').stack;}globalThis.positionResults=[boundary()];`;
fixtures.push(' '.repeat(262144-suffix.length)+suffix);
const actual=[];for(const code of fixtures){const engine=new QjsEngine();assert.equal(engine.eval(code,'source-position-fixture.js',false),0);actual.push(engine.callGlobal('eval','positionResults').value.map(stack=>stack.split('\n')[0]));engine.dispose();}
const path='test/fixtures/source-positions.json';
if(process.env.QJSB_WRITE_SOURCE_POSITIONS==='1')fs.writeFileSync(path,JSON.stringify(actual,null,2)+'\n');
else assert.deepEqual(actual,JSON.parse(fs.readFileSync(path,'utf8')));
console.log('PASS exact upstream stack positions for nested/minified functions, UTF-8 checkpoints, line boundaries and an exact 256 KiB source boundary');
