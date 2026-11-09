import {WorkerEntrypoint} from 'cloudflare:workers';
const response=()=>new Response('This service has been retired.',{status:410,headers:{'Cache-Control':'no-store'}});
/** Final owner retirement artifact. No product bindings, data reads or effects. */
export class RetiredEntrypoint extends WorkerEntrypoint {
 async fetch(){return response();}
 async runScheduled(){return {ok:false,state:'retired',error:'retired'};}
}
export {RetiredEntrypoint as ScheduledIngress,RetiredEntrypoint as UccScheduler,RetiredEntrypoint as KvIncidentScheduledIngress};
export default {fetch:response,async scheduled(){}};
