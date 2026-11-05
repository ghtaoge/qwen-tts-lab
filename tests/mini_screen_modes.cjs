const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const sent=[];let definition;
const api={request:async(url,method,body)=>{sent.push({url,method,body});return{id:'screen',status:'queued',parts:[],...body};}};
const sandbox={require:()=>api,Page:value=>definition=value,Date,Map,setTimeout(){},clearTimeout(){},setInterval(){},clearInterval(){},wx:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../miniprogram/pages/index/index.js'),'utf8'),sandbox);
const page=Object.assign({},definition,{alive:true,data:{...definition.data,text:'你好',sendDevice:true,deviceId:'board'},setData(update){Object.assign(this.data,update);},resetPlayback(){},beginElapsed(){},applyJob(){},pollJob(){}});
(async()=>{
  for(const mode of ['buddy','wave','text']){
    const before=sent.length;page.selectDisplayMode({currentTarget:{dataset:{id:mode}}});
    assert.equal(sent.length,before,'mode selection must not create an extra network request');
    page.data.busy=false;await page.generate();
    assert.equal(sent.at(-1).body.display_mode,mode);assert.equal(sent.at(-1).body.playback_mode,'complete');assert.equal(sent.at(-1).url,'/api/jobs');
  }
  page.selectDisplayMode({currentTarget:{dataset:{id:'unknown'}}});assert.equal(page.data.displayMode,'text');
  const actual=Object.assign({},definition,{alive:true,data:{},setData(update){Object.assign(this.data,update);},resetPlayback(){},refreshHistory(){}});
  const base={id:'state',parts:[],device_id:'board'};
  actual.applyJob({...base,status:'completed',delivery:'pending'});assert.match(actual.data.screenHint,/等小伙伴接收/);
  actual.applyJob({...base,status:'completed',delivery:'playing'});assert.match(actual.data.screenHint,/跟着声音动/);
  actual.applyJob({...base,status:'completed',delivery:'delivered',device_delivery_simulated:true});assert.match(actual.data.screenHint,/模拟/);
  actual.applyJob({...base,status:'failed'});assert.match(actual.data.screenHint,/小状况/);
  console.log('Mini screen modes: existing request only, all themes, validation and real/simulated lifecycle checked.');
})().catch(error=>{console.error(error);process.exitCode=1;});
