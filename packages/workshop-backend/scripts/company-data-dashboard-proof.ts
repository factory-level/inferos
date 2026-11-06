/** Install three real service widgets on a local saved canvas. Uses only Workshop APIs.
 * Run after the scoped synthetic InferOps connection and native fixture are ready.
 * node packages/workshop-backend/scripts/company-data-dashboard-proof.ts <local-url> <board-ref>
 * The browser session is written mode 0600 under /tmp, never printed or committed.
 */
import { writeFileSync } from 'node:fs';
import type { RpcStub } from 'capnweb';
import type { GadgetStub, ServiceQueryName } from '../../bundled-blueprints/libraries/service-dashboard/protocol.ts';
import type { CanvasWidget } from '@gadgets/workshop-shared/canvas';
import { connectWorkshop, localWorkshopUrl, passwordHash, listConnectedAccounts } from './dev-workshop.ts';
const base = localWorkshopUrl(process.argv[2] ?? 'http://localhost:17887');
const boardRef = process.argv[3];
if (!boardRef || !/^inferops:\/\/[^/]+\/project\/board\/[^/]+$/.test(boardRef)) throw new Error('Supply the synthetic company board reference');
const { api, close } = connectWorkshop(base, 120_000);
try {
 const username='fac172proof'; const hash=passwordHash(username,'local-synthetic-proof');
 const token=await api.login(username,hash) ?? await api.createAccount(username,username,hash);
 if (!token) throw new Error('Synthetic local account could not sign in');
 using user=await api.authenticate(token);
 await user.completeOnboarding();
 if ((await user.listAddableGatekeepers()).some(v=>v.id==='inferops')) await user.provisionAmbientAccount('inferops');
 const account=(await listConnectedAccounts(user)).find(a=>a.vendorId==='inferops');
 if(!account) throw new Error('No InferOps account');
 using installed=await user.newGadget();
 await installed.setTitle("Company service dashboard");
 const metadata=await installed.getMetadata();
 const kinds: ServiceQueryName[]=['service-jobs','service-job-status-counts','service-job-recent-activities'];
 const widgets: CanvasWidget[]=[]; const responses=[];
 for(const name of kinds) {
  const id=await installed.installBlueprint('inferops.'+name,{project:{type:'gatekeeper',accountId:account.id,resourceUrl:boardRef}},{requestKey:'fac172-'+name});
  using gadget=await installed.getGadget(id);
  using facet=await gadget.connectToGadget() as RpcStub<GadgetStub>;
  const result=await facet.query(name);
  responses.push(result.ok ? {name,ok:true,rows:result.page.rows.length} : {name,ok:false,reason:result.reason});
  widgets.push({id:name,kind:'inferos.gadget',version:1,targetRef:'gadget:'+id,size:name==='service-jobs'?'full':'wide',params:{}});
 }
 const screen=await installed.createCanvas({title:'Service operations',sections:[{id:'service',title:'Service operations',columns:2,widgets}]});
 writeFileSync('/tmp/fac172-inferos-browser-session.json',JSON.stringify({token,workspaceId:metadata.id,screenId:screen.id,url:base.toString()}),{mode:0o600});
 console.log(JSON.stringify({workspaceId:metadata.id,screenId:screen.id,responses}));
 if (responses.some(result => !result.ok)) process.exitCode = 1;
} finally {close();}
