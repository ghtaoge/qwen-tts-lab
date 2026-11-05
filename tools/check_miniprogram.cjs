const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'../miniprogram');
let count=0;
function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())visit(file);else if(file.endsWith('.js')){new vm.Script(fs.readFileSync(file,'utf8'),{filename:file});count++;}else if(file.endsWith('.json'))JSON.parse(fs.readFileSync(file,'utf8'));}}
visit(root);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'));
for(const page of manifest.pages){for(const ext of ['.js','.json','.wxml','.wxss']){if(!fs.existsSync(path.join(root,page+ext)))throw new Error('Missing page asset: '+page+ext);}}
const page=fs.readFileSync(path.join(root,'pages/index/index.wxml'),'utf8');
const handlers=[...page.matchAll(/bind(?:tap|input|change)="([A-Za-z][A-Za-z0-9]*)"/g)].map(m=>m[1]);
const source=fs.readFileSync(path.join(root,'pages/index/index.js'),'utf8');
let definition;
vm.runInNewContext(source,{require:()=>({}),Page:value=>definition=value,wx:{}});
for(const handler of handlers)if(typeof definition[handler]!=='function')throw new Error('Missing WXML event handler: '+handler);
console.log(`Mini-program: ${count} JavaScript files, JSON, page assets and ${new Set(handlers).size} event handlers checked.`);
