import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const result = await build({entryPoints:['src/runtime.ts'],bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
const options = {workers:[
  {name:'product',modules:true,script:result.outputFiles[0].text,compatibilityDate:'2026-04-01',compatibilityFlags:['nodejs_compat'],outboundService:()=>{throw Error('unexpected effect');}},
  {name:'caller',modules:true,script:`export default {fetch(request,env){return env.PRODUCT.fetch(request)}}`,compatibilityDate:'2026-04-01',serviceBindings:{PRODUCT:{name:'product',entrypoint:'ScheduledIngress'}}}
]};
const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
try {
 const product = await mf.getWorker('product');
 const caller = await mf.getWorker('caller');
 for(const method of ['GET','POST']) {
  const response = await product.fetch('https://product/internal/run-scheduled',{method,headers:{'X-Scheduler-RID':'forged'},...(method==='POST'?{body:'{}'}:{})});
  assert.equal(response.status,404);
 }
 const response = await caller.fetch('https://internal/internal/run-scheduled',{method:'POST',body:JSON.stringify({target:'wrong',capability:'wrong'})});
 assert.equal(response.status,400);
 assert.equal((await caller.fetch('https://internal/health')).status,404);
 console.log('workerd: public ingress denied; named binding reaches validation; unrelated paths denied');
} finally {await mf.dispose();}
