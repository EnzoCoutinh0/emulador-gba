const fs=require('fs');const {GBA}=require('../core.js');const g=new GBA();g.loadRom(new Uint8Array(fs.readFileSync(process.argv[2])));
for(let i=0;i<60;i++)g.runFrame();
let t=Date.now();for(let i=0;i<900;i++)g.runFrame();console.log('fps',(900/((Date.now()-t)/1000)).toFixed(0));
