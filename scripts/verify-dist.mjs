import assert from 'node:assert/strict';
import plugin from '../dist/index.js';
import {Store} from '../dist/store.js';

const tools=[],methods=[],services=[];
plugin.register({
  pluginConfig:{statePath:':memory:',enabled:false,productAgentId:'product',engineeringAgentId:'engineering',sessionNamespace:'project-flow',fallbackDestinations:{product:{channel:'test',accountId:'product',to:'test:product-owner',kind:'direct'},engineering:{channel:'test',accountId:'engineering',to:'test:engineering-owner',kind:'direct'}},worker:{agentId:'worker',runtime:'acp',profiles:[{id:'routine',model:'provider/worker',thinking:'medium',description:'Routine work.'}]}},
  logger:{warn(){}},registerTool(factory,options){tools.push(options.name);},registerGatewayMethod(name){methods.push(name);},registerService(service){services.push(service.id);},on(){},
});
assert.deepEqual(tools,['jarvis_project','gilfoyle_engineering']);assert.deepEqual(methods,['jarvis-gilfoyle.projects.call','jarvis-gilfoyle.projects.guard','jarvis-gilfoyle.projects.tick','jarvis-gilfoyle.projects.health']);assert.deepEqual(services,['jarvis-gilfoyle-project-recovery']);
const store=new Store(':memory:'),route={conversationRef:`conv_${'a'.repeat(32)}`,channel:'test',accountId:'default',target:'owner',kind:'direct'},project=store.declare({key:'compiled',name:'Compiled',purpose:'Prove built output',route,productFallback:route});store.enqueue({project:project.id,event:'result',message:'Built output works'});assert.equal(store.get('SELECT role FROM deliveries').role,'product');store.close();
console.log('Compiled distribution verified');
