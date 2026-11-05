Component({
  data:{selected:0,items:[
    {text:'生成',path:'/pages/index/index'},
    {text:'记录',path:'/pages/history/index'},
    {text:'设备',path:'/pages/device/index'}
  ]},
  methods:{
    selectTab(event){
      const index=Number(event.currentTarget.dataset.index),item=this.data.items[index];
      if(!item||this.switching||index===this.data.selected)return;
      this.switching=true;
      wx.switchTab({url:item.path,success:()=>this.setData({selected:index}),complete:()=>{this.switching=false;}});
    }
  }
});
