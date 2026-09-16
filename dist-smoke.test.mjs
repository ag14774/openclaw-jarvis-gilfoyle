import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from './dist/index.js';
import {Store} from './dist/store.js';

test('compiled package registers declared tools and persists generic roles',()=>{
  const tools=[],methods=[],services=[];
  plugin.register({
    pluginConfig:{statePath:':memory:',enabled:false,productAgentId:'product',engineeringAgentId:'engineering',workerAgentId:'worker',sessionNamespace:'project-flow',fallbackConversations:{product:'conv_product',engineering:'conv_engineering'},worker:{runtime:'acp',model:'provider/worker',thinking:'medium'},advisor:{model:'provider/advisor',thinking:'low',timeoutSeconds:300}},
    logger:{warn(){}},registerTool(factory,options){tools.push(options.name);},registerGatewayMethod(name){methods.push(name);},registerService(service){services.push(service.id);},on(){},
  });
  assert.deepEqual(tools,['jarvis_project','gilfoyle_engineering']);assert.deepEqual(methods,['jarvis-gilfoyle.projects.call','jarvis-gilfoyle.projects.guard','jarvis-gilfoyle.projects.tick','jarvis-gilfoyle.projects.health']);assert.deepEqual(services,['jarvis-gilfoyle-project-recovery']);
  const store=new Store(':memory:'),route={conversationRef:`conv_${'a'.repeat(32)}`,channel:'test',accountId:'default',target:'owner',kind:'direct'},project=store.declare({key:'compiled',name:'Compiled',purpose:'Prove built output',route,productFallback:route});store.enqueue({project:project.id,event:'result',message:'Built output works'});assert.equal(store.get('SELECT role FROM deliveries').role,'product');store.close();
});
