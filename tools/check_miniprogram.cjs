const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'../miniprogram');
let count=0;
function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())visit(file);else if(file.endsWith('.js')){new vm.Script(fs.readFileSync(file,'utf8'),{filename:file});count++;}else if(file.endsWith('.json'))JSON.parse(fs.readFileSync(file,'utf8'));}}
visit(root);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'));
for(const page of manifest.pages){for(const ext of ['.js','.json','.wxml','.wxss']){if(!fs.existsSync(path.join(root,page+ext)))throw new Error('Missing page asset: '+page+ext);}}
const wxStub={getStorageSync:()=>({}),setStorageSync(){}};
const preferenceContext={module:{exports:{}},wx:wxStub};
vm.runInNewContext(fs.readFileSync(path.join(root,'lib/preferences.js'),'utf8'),preferenceContext);
let handlerCount=0;
for(const pagePath of manifest.pages){
  const page=fs.readFileSync(path.join(root,pagePath+'.wxml'),'utf8');
  const handlers=[...page.matchAll(/\b(?:bind|catch):?(?:tap|input|change|changing|confirm|submit)="([A-Za-z][A-Za-z0-9]*)"/g)].map(m=>m[1]);
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root,pagePath+'.js'),'utf8'),{
    require:name=>name.includes('preferences')?preferenceContext.module.exports:{},
    Page:value=>definition=value,wx:wxStub
  });
  for(const handler of handlers)if(typeof definition[handler]!=='function')throw new Error(pagePath+': missing handler '+handler);
  handlerCount+=new Set(handlers).size;
}
for(const tab of manifest.tabBar.list)if(!manifest.pages.includes(tab.pagePath))throw new Error('Unregistered tab '+tab.pagePath);
if(manifest.tabBar.custom){
  const component='custom-tab-bar/index';
  for(const ext of ['.js','.json','.wxml','.wxss'])if(!fs.existsSync(path.join(root,component+ext)))throw new Error('Missing custom tab asset '+ext);
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root,component+'.js'),'utf8'),{Component:value=>definition=value,wx:wxStub});
  const handlers=[...fs.readFileSync(path.join(root,component+'.wxml'),'utf8').matchAll(/\b(?:bind|catch):?tap="([A-Za-z][A-Za-z0-9]*)"/g)].map(match=>match[1]);
  for(const handler of handlers)if(typeof definition.methods[handler]!=='function')throw new Error('Missing custom tab handler '+handler);
  handlerCount+=new Set(handlers).size;
}
console.log(`Mini-program: ${count} JavaScript files, JSON, ${manifest.pages.length} pages and ${handlerCount} event handlers checked.`);
