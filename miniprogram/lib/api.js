let defaults;
try { defaults = require('../config.local'); } catch (_) { defaults = require('../config.example'); }
function config() { return Object.assign({}, defaults, wx.getStorageSync('qwenConnection') || {}); }
function request(path, method, data) {
  const settings=config();
  return new Promise((resolve,reject)=>wx.request({
    url:settings.baseUrl.replace(/\/$/,'')+path,method:method||'GET',data,
    timeout:15000,header:{'Content-Type':'application/json','X-Client-Token':settings.clientToken},
    success(response){
      if(response.statusCode>=200&&response.statusCode<300){resolve(response.data);return;}
      let detail=response.data&&response.data.detail;
      if(Array.isArray(detail))detail=detail.map(v=>v.msg).join('；');
      const error=new Error(detail||`请求失败 ${response.statusCode}`);error.status=response.statusCode;reject(error);
    },fail(error){reject(new Error(error.errMsg||'无法连接，请检查局域网地址、权限和电脑防火墙'));}
  }));
}
function download(path) {
  const settings=config();
  let task;
  const promise=new Promise((resolve,reject)=>{task=wx.downloadFile({url:settings.baseUrl.replace(/\/$/,'')+path,
    header:{'X-Client-Token':settings.clientToken},timeout:60000,
    success(response){if(response.statusCode===200)resolve(response.tempFilePath);else reject(new Error('音频下载失败：'+response.statusCode));},
    fail(error){reject(new Error(error.errMsg||'音频下载失败'));}
  });});
  promise.abort=()=>task&&task.abort();
  return promise;
}
module.exports={config,request,download};
